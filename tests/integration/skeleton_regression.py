#!/usr/bin/env python3
"""the walking skeleton still works end-to-end after the crypto/pairing/sync work.
and fail-closed on daemon death still holds."""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, DAEMON_PKILL_PATTERN, check, fail, start_daemon, stop_daemon, pair_and_connect, wait_for

for m in ('ALLOWED_MARKER', 'DENIED_MARKER'):
    try:
        os.remove(os.path.join(TB, m))
    except FileNotFoundError:
        pass


def reader(fh, sessions, approvals):
    for line in fh:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get('type')
        if t == 'session_list':
            sessions.extend(ev['sessions'])
        if t == 'session_update':
            sessions.append(ev['session'])
        if t == 'approval_pending':
            approvals.append(ev['approval'])


print("=== end-to-end approve path ===")
start_daemon('/tmp/reg1.log')
f, _device_id = pair_and_connect()
sessions, approvals = [], []
threading.Thread(target=reader, args=(f, sessions, approvals), daemon=True).start()
time.sleep(1)
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "reg"}) + "\n"); f.flush()
time.sleep(5)
sid = [s for s in sessions if s['label'] == 'reg'][0]['id']
f.write(json.dumps({"type": "send", "sessionId": sid,
    "text": "Run exactly this bash command and nothing else: touch ALLOWED_MARKER"}) + "\n"); f.flush()
if not wait_for(lambda: bool(approvals)):
    fail(f"no approval arrived (sessions seen: {[s.get('label') for s in sessions]})")
a = approvals[0]
print(f"  approval: {a['toolName']} desc={a.get('description')!r} corr={a['sessionId'] == sid}")
f.write(json.dumps({"type": "decide", "toolUseId": a['toolUseId'], "decision": "allow",
    "reason": "regression", "by": "reg-test"}) + "\n"); f.flush()
time.sleep(10)
check(os.path.exists(os.path.join(TB, 'ALLOWED_MARKER')), "ALLOWED_MARKER exists after allow")

print("\n=== fail-closed on daemon crash ===")
# Reuses the earlier session and connection deliberately. This previously spawned a SECOND session on a
# SECOND paired device, and that second session was where the suite flaked: it would stay alive and
# emit a dozen state updates but never call a tool, so the wait expired with a failure that said
# nothing about fail-closed. The hypothesis under test here is only "a pending approval fails closed
# when the daemon dies", it needs one pending approval, not a fresh session or a fresh device.
# Dropping that dependency removes the flake surface and halves the API cost of this script.
approvals.clear()
f.write(json.dumps({"type": "send", "sessionId": sid,
    "text": "Run exactly this bash command and nothing else: touch DENIED_MARKER"}) + "\n"); f.flush()
if not wait_for(lambda: bool(approvals)):
    fail("approval never went pending, cannot test fail-closed on crash "
         f"(sessions seen: {[s.get('label') for s in sessions]}; see /tmp/reg1.log for session stderr)")
print("  approval pending: True")
import subprocess
subprocess.run(DAEMON_PKILL_PATTERN, shell=True)
time.sleep(15)
check(not os.path.exists(os.path.join(TB, 'DENIED_MARKER')), "DENIED_MARKER absent, fail-closed held")

stop_daemon()
print("\nPASS")
