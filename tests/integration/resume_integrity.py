#!/usr/bin/env python3
"""Resume integrity: the daemon may only answer "you are caught up" when that claim is possible.

`resumed: true` with no events means the daemon sends NO full resync, no sessions, no jobs, and
no pending approvals. So believing an impossible lastSeq silently blinds a client: a tool call sits
blocked on this machine and the client is never told a decision is needed.

Zero API cost: a blocked tool call is simulated by speaking the hook bridge's line protocol
directly, exactly as hook/approve-bridge.mjs does, instead of driving a real `claude` session.

A: an honest client (lastSeq=0) is told about the pending approval.
B: a client claiming a lastSeq AHEAD of anything issued gets a FULL RESYNC (not silence).
C: a client exactly level with what was sent is still treated as caught up (resume still works).
"""
import base64
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _crypto
from _lib import check, fail, start_daemon, stop_daemon, raw_client, pair_only, hello

HOOK_SOCK = '/tmp/cc-daemon.sock'


def frames(f, key, seconds=1.5):
    """Every decoded event that arrives within the window, in order."""
    got = []

    def rd():
        for line in f:
            try:
                got.append(_crypto.open_frame(key, json.loads(line)))
            except Exception:
                continue

    threading.Thread(target=rd, daemon=True).start()
    time.sleep(seconds)
    return got


def reconnect(priv, dpub, dev, last_seq):
    f = raw_client()
    ch, resp = hello(f, priv, dpub, dev, last_seq=last_seq)
    evs = frames(f, ch._key)
    try:
        f._sock.shutdown(socket.SHUT_RDWR)
        f.close()
    except OSError:
        pass
    return resp, [e.get('type') for e in evs], evs


stop_daemon()
time.sleep(1)
start_daemon('/tmp/resume_integrity.log')

f, priv, pub, dpub, dev = pair_only('resume-integrity')
ch, _ = hello(f, priv, dpub, dev)
first = frames(f, ch._key)
highest = 0  # track what the daemon has actually issued to this device
ch.close()
time.sleep(0.5)

# Block a tool call: this socket stays open, exactly like a real hook awaiting a decision.
hook = socket.socket(socket.AF_UNIX)
hook.connect(HOOK_SOCK)
hook.sendall((json.dumps({
    "kind": "approval_request",
    "event": {
        # Unique per run: the approvals table is keyed by tool_use_id and PERSISTS across runs,
        # so a fixed id collides on the second run. (That collision currently kills the daemon,
        # tracked separately as a robustness defect; this test is about resume integrity.)
        "tool_use_id": f"toolu_resume_integrity_{int(time.time() * 1000)}",
        "session_id": "sess-resume-integrity",
        "tool_name": "Bash",
        "tool_input": {"command": "touch X", "description": "needs a decision"},
    },
}) + "\n").encode())
time.sleep(1.5)

print("=== A: an honest client is told about the pending approval ===")
resp_a, types_a, _ = reconnect(priv, dpub, dev, 0)
print(f"  resumed={resp_a.get('resumed')} frames={types_a}")
check('approval_pending' in types_a, "A: honest client receives the pending approval")

print("\n=== B: a lastSeq ahead of anything issued must force a full resync ===")
resp_b, types_b, _ = reconnect(priv, dpub, dev, 10 ** 9)
print(f"  resumed={resp_b.get('resumed')} frames={types_b}")
check(resp_b.get('resumed') is False,
      "B: an impossible lastSeq is refused as a resume (resumed=false)")
check('approval_pending' in types_b,
      "B: and the client still learns a tool call is blocked awaiting its decision")
check('session_list' in types_b, "B: a full resync was sent, not silence")

print("\n=== C: a client exactly level is still treated as caught up (resume not broken) ===")
# Establish the true high-water mark by reconnecting honestly and taking the highest seq seen.
fx = raw_client()
chx, respx = hello(fx, priv, dpub, dev, last_seq=0)
seqs = []
def rdx():
    for line in fx:
        try:
            fr = json.loads(line)
            _crypto.open_frame(chx._key, fr)
            seqs.append(fr['seq'])
        except Exception:
            continue
threading.Thread(target=rdx, daemon=True).start()
time.sleep(1.5)
level = max(seqs) if seqs else 0
try:
    fx._sock.shutdown(socket.SHUT_RDWR); fx.close()
except OSError:
    pass
print(f"  highest seq issued to this device: {level}")

resp_c, types_c, _ = reconnect(priv, dpub, dev, level)
print(f"  resumed={resp_c.get('resumed')} replayedCount={resp_c.get('replayedCount')} frames={types_c}")
check(resp_c.get('resumed') is True,
      "C: a client exactly level with what was sent still resumes (no spurious full resync)")
check(resp_c.get('replayedCount') == 0, "C: and nothing is replayed to it")

try:
    hook.close()
except OSError:
    pass
stop_daemon()
print("\nPASS")
