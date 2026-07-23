#!/usr/bin/env python3
"""The daemon actually enforces pairing + encryption on the live socket, not just
in isolated crypto unit tests. Three angles: a command sent before pairing is refused and the
connection is closed; hello with an unknown deviceId is refused; a frame sealed under the
wrong key (a relay without the real session key) is rejected and the connection is closed."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, check, fail, start_daemon, stop_daemon, raw_client, pair_and_connect
import _crypto

start_daemon('/tmp/v30.log')

print("=== A: command sent before pairing is refused, connection closed ===")
f = raw_client()
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "unauth-probe"}) + "\n"); f.flush()
time.sleep(1)
closed = False
try:
    data = f.readline()
    closed = data == ''  # EOF: daemon called sock.destroy()
except Exception:
    closed = True
check(closed, "A: daemon closes the connection instead of executing an unauthenticated command")

print("\n=== B: verify via a properly paired connection that nothing was spawned ===")
f2, _ = pair_and_connect('auth-check')
f2.write(json.dumps({"type": "list"}) + "\n"); f2.flush()
t0 = time.time()
sessions = None
for line in f2:
    ev = json.loads(line)
    if ev.get('type') == 'session_list':
        sessions = ev['sessions']
        break
    if time.time() - t0 > 10:
        break
check(sessions is not None, "B: got a session_list from the daemon")
check(not any(s['label'] == 'unauth-probe' for s in (sessions or [])), "B: the unauthenticated spawn never created a session")

print("\n=== C: hello with an unknown deviceId is refused ===")
f3 = raw_client()
f3.write(json.dumps({"type": "hello", "deviceId": "not-a-real-device-id"}) + "\n"); f3.flush()
resp = json.loads(f3.readline())
check(resp.get('type') == 'hello_failed', "C: unknown deviceId gets hello_failed")
time.sleep(0.5)
closed = f3.readline() == ''
check(closed, "C: connection closed after hello_failed")

print("\n=== D: a frame sealed under the wrong key is rejected and the connection is closed ===")
f4, device_id = pair_and_connect('wrong-key-probe')
# Drain the daemon's unsolicited post-hello session_list frame first, otherwise it sits
# buffered ahead of the bad frame and the readline() below would return it instead of EOF,
# making a still-open connection look closed for the wrong reason.
initial = json.loads(next(iter(f4)))
check(initial.get('type') == 'session_list', "D: initial session_list frame decrypts cleanly before the tamper probe")

wrong_key = os.urandom(32)  # simulates a relay/attacker without the real session key
bad_frame = _crypto.seal(wrong_key, 1, {"type": "list"})
f4._f.write(json.dumps(bad_frame) + "\n"); f4._f.flush()  # bypass SealedChannel's own (correct) key
time.sleep(1)
closed = f4._f.readline() == ''
check(closed, "D: daemon closes the connection on a frame it cannot decrypt")

stop_daemon()
print("\nPASS")
