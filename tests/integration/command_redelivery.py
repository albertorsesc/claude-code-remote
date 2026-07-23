#!/usr/bin/env python3
"""client→daemon command redelivery against the live daemon, the reverse analog
of reconnect_replay.py. Zero API cost via a refused spawn (bad cwd → job_update broadcast + error,
no real `claude -p`). The correctness core: a command resent after a dropped connection is DEDUPED
by the daemon (not re-executed), except across a daemon restart where fresh re-execution is safe.

Reads via per-channel reader threads (blocking, no socket timeout, a makefile read that times out
is left unusable), stopped between reconnects with channel.close() (shutdown-first, unblocks the
reader). The acks are applied+swallowed transparently by SealedChannel."""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import check, fail, start_daemon, stop_daemon, pair_only, hello, raw_client, ClientSeqState

STORE = '/tmp/cc-cmd-redelivery-identity.json'
try:
    os.remove(STORE)
except FileNotFoundError:
    pass

BADPROJ = tempfile.mkdtemp(prefix='cc-cmd-redelivery-noproj-')  # no .claude/settings.json → refused spawn
SPAWN = {"type": "spawn", "cwd": BADPROJ, "label": "redeliver-me"}

# Distinct job ids ever seen per label, across every reconnect (a set, dedups naturally).
jobs = {}


def on_event(ev):
    if ev.get('type') == 'job_update':
        jobs.setdefault(ev['job'].get('label'), set()).add(ev['job']['id'])


print("=== A: send a (refused) spawn as a buffered write command, see one job + an ack ===")
_proc, store = start_daemon('/tmp/v40.log', store=STORE)
f, dev_priv, dev_pub, daemon_pub, dev_id = pair_only('cmd-redelivery')
state = ClientSeqState()
channel, salt = hello(f, dev_priv, daemon_pub, dev_id, seq_state=state)
channel.start_reader(on_event)
seq1 = channel.write(json.dumps(SPAWN)); channel.flush()
time.sleep(2)
check(len(jobs.get("redeliver-me", set())) == 1, "A: exactly one job created for the command")
check(state.max_acked >= seq1, f"A: the daemon acked the command (max_acked={state.max_acked} >= {seq1})")

print("\n=== B (exactly-once): drop socket with the command still unacked, reconnect, resend → deduped ===")
# Simulate the ack having been LOST in the drop. Both halves matter: the command is still pending
# resend, AND the client never learned it was processed. Resetting max_acked is what makes the
# assertion below real, leaving it at its step-A value made the check already true before step B
# ran, so it passed even with the daemon's post-hello ack deleted entirely.
state.unacked[seq1] = SPAWN
state.max_acked = 0
channel.close()
time.sleep(0.5)
f2 = raw_client()
channel2, salt2 = hello(f2, dev_priv, daemon_pub, dev_id, last_seq=channel.last_seq_received, seq_state=state)
channel2.start_reader(on_event)
channel2.resend_unacked()     # resend seq1, the daemon must dedup it, not re-execute
time.sleep(2)
check(len(jobs.get("redeliver-me", set())) == 1, "B: the resent command did NOT create a second job (deduped)")
check(state.max_acked >= seq1,
      f"B: the POST-HELLO ack drained the already-processed command (max_acked={state.max_acked}). "
      "This is the hole it closes: a deduped resend runs no handler, so it emits no steady-state "
      "ack, without the post-hello ack the client would resend forever.")

print("\n=== C (restart boundary): restart daemon (same identity), resend → fresh re-execution is safe ===")
state.unacked[seq1] = SPAWN
channel2.close()
time.sleep(0.5)
_proc2, _ = start_daemon('/tmp/v40-restart.log', store=STORE)
f3 = raw_client()
channel3, salt3 = hello(f3, dev_priv, daemon_pub, dev_id, seq_state=state)
channel3.start_reader(on_event)
channel3.resend_unacked()
time.sleep(2)
check(len(jobs.get("redeliver-me", set())) == 2,
      "C: after a restart the resend re-executes (a second, distinct job), safe, the old state was wiped")

print("\n=== D (steady-state drain): a second command is acked and drops from the resend buffer ===")
seq2 = channel3.write(json.dumps({"type": "spawn", "cwd": BADPROJ, "label": "second"})); channel3.flush()
time.sleep(2)
check(state.max_acked >= seq2, f"D: second command acked (max_acked={state.max_acked} >= {seq2})")
check(seq2 not in state.unacked, "D: the acked command was dropped from the resend buffer")

stop_daemon()
print("\nPASS")
