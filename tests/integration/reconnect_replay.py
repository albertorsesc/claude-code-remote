#!/usr/bin/env python3
"""cross-reconnect replay actually works against the live daemon, not just in isolated
unit tests. Zero API cost, reuses job_queue.py's technique of a refused spawn (bad project,
no .claude/settings.json) broadcasting a job_update with no real `claude -p` process involved."""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import ROOT, TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_only, hello, raw_client

STORE = '/tmp/cc-reconnect-replay-identity.json'
try:
    os.remove(STORE)
except FileNotFoundError:
    pass

print("=== A: pair, first hello gets resumed: false (baseline) ===")
_proc, store = start_daemon('/tmp/v35.log', store=STORE)
f1, dev1_priv, dev1_pub, daemon_pub, dev1_id = pair_only('reconnect-a')
channel1, salt_resp = hello(f1, dev1_priv, daemon_pub, dev1_id)
check(salt_resp.get('resumed') is False, "A: first-ever hello is never a resume")

# Drain the initial session_list the daemon already sent as part of the full resync, otherwise
# it sits unread and last_seq_received stays 0, understating what device A has actually seen
# (same class of bug as auth_required.py's case D: an unread buffered frame skews the next check).
initial = json.loads(next(iter(channel1)))
check(initial.get('type') == 'session_list', "A: drained the initial full-resync session_list")

print("\n=== B: disconnect device A ===")
f1.close()
time.sleep(0.5)

print("\n=== C: a second device triggers a cheap job_update that device A misses ===")
badproj = tempfile.mkdtemp(prefix='cc-reconnect-replay-noproj-')
f2, dev2_priv, dev2_pub, _daemon_pub2, dev2_id = pair_only('reconnect-b')
channel2, _ = hello(f2, dev2_priv, daemon_pub, dev2_id)
channel2.write(json.dumps({"type": "spawn", "cwd": badproj, "label": "missed-job"}) + "\n"); channel2.flush()
time.sleep(1)

print("\n=== D: device A reconnects with its captured lastSeq, gets resumed: true, sees the missed event ===")
f1b = raw_client()
channel1b, salt_resp_b = hello(f1b, dev1_priv, daemon_pub, dev1_id, last_seq=channel1.last_seq_received)
check(salt_resp_b.get('resumed') is True, "D: reconnect with a valid lastSeq is a resume")
check(salt_resp_b.get('replayedCount', 0) >= 1, "D: at least one event was replayed")

replayed = json.loads(next(iter(channel1b)))
check(replayed.get('type') == 'job_update' and replayed['job'].get('label') == 'missed-job',
      "D: the replayed event is exactly the one device A missed while disconnected")

print("\n=== E: daemon restart with the same identity, reconnect with a pre-restart lastSeq forces resumed: false ===")
pre_restart_seq = channel1b.last_seq_received
f1b.close()
time.sleep(0.5)
_proc2, _store2 = start_daemon('/tmp/v35-restart.log', store=STORE)  # same CC_STORE, same on-disk identity
f1c = raw_client()
channel1c, salt_resp_c = hello(f1c, dev1_priv, daemon_pub, dev1_id, last_seq=pre_restart_seq)
check(salt_resp_c.get('resumed') is False,
      "E: a lastSeq from before a daemon restart forces a full resync, not a false 'nothing missed'")

print("\n=== F: buffer overflow while disconnected also forces resumed: false (gap path) ===")
_proc3, _store3 = start_daemon(
    '/tmp/v35-gap.log', store=STORE,
    extra_env={'CC_REPLAY_MAX_EVENTS_PER_DEVICE': '2'},
)
f1d = raw_client()
channel1d, salt_resp_d = hello(f1d, dev1_priv, daemon_pub, dev1_id)
check(salt_resp_d.get('resumed') is False, "F: fresh process after restart, another full resync")
json.loads(next(iter(channel1d)))  # drain the resync's session_list before reading last_seq_received
last_seq_before_gap = channel1d.last_seq_received
f1d.close()
time.sleep(0.5)

f3, dev3_priv, dev3_pub, _daemon_pub3, dev3_id = pair_only('reconnect-c')
channel3, _ = hello(f3, dev3_priv, daemon_pub, dev3_id)
for i in range(5):  # blow past the 2-event buffer
    channel3.write(json.dumps({"type": "spawn", "cwd": badproj, "label": f"gap-{i}"}) + "\n"); channel3.flush()
    time.sleep(0.3)

f1e = raw_client()
channel1e, salt_resp_e = hello(f1e, dev1_priv, daemon_pub, dev1_id, last_seq=last_seq_before_gap)
check(salt_resp_e.get('resumed') is False, "F: a buffer-overflow gap forces a full resync, not a partial replay")

stop_daemon()
print("\nPASS")
