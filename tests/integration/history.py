#!/usr/bin/env python3
"""the `history` command reads the durable approval audit trail back over the live protocol.
Real API cost, drives one real approval to a decision (same pattern as audit_trail.py), then
queries it back via the client command rather than reopening the SQLite file directly."""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect, APPROVAL_WAIT_S

DB_PATH = '/tmp/cc-history-test.db'
for p in (DB_PATH, os.path.join(TB, 'HISTORY_MARKER')):
    try:
        os.remove(p)
    except FileNotFoundError:
        pass

start_daemon('/tmp/v39.log', extra_env={'CC_DB_PATH': DB_PATH})
f, device_id = pair_and_connect("history-test")

sessions, approvals, history = [], [], []


def reader():
    for line in f:
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
        if t == 'approval_history':
            history.append(ev['approvals'])


threading.Thread(target=reader, daemon=True).start()
time.sleep(1)

print("=== A: history is empty before any approval is decided ===")
f.write(json.dumps({"type": "history"}) + "\n"); f.flush()
t0 = time.time()
while time.time() - t0 < 10 and not history:
    time.sleep(0.2)
check(history and history[0] == [], "A: history is an empty list before anything is decided")
history.clear()

print("\n=== B: drive one real approval to a decision ===")
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "history"}) + "\n"); f.flush()
time.sleep(5)
sid = [s for s in sessions if s['label'] == 'history'][0]['id']
f.write(json.dumps({"type": "send", "sessionId": sid,
    "text": "Run exactly this bash command and nothing else: touch HISTORY_MARKER"}) + "\n"); f.flush()
t0 = time.time()
while time.time() - t0 < APPROVAL_WAIT_S and not approvals:
    time.sleep(0.3)
if not approvals:
    fail("no approval arrived, cannot test history")
a = approvals[0]
f.write(json.dumps({"type": "decide", "toolUseId": a['toolUseId'], "decision": "allow",
    "reason": "history-test-reason", "by": "history-tester"}) + "\n"); f.flush()
time.sleep(3)

print("\n=== C: history now returns that decided approval over the protocol ===")
f.write(json.dumps({"type": "history"}) + "\n"); f.flush()
t0 = time.time()
while time.time() - t0 < 10 and not history:
    time.sleep(0.2)
check(bool(history), "C: got an approval_history response")
entries = history[0]
check(len(entries) == 1, "C: exactly one decided approval in history")
entry = entries[0]
check(entry['toolUseId'] == a['toolUseId'], "C: correct tool_use_id")
check(entry['decision'] == 'allow', "C: correct decision")
check(entry['reason'] == 'history-test-reason', "C: correct reason")
# Attribution is the authenticated deviceId first, then the client's human label.
check(entry['decidedBy'].startswith(device_id),
      f"C: decision attributed to the authenticated device (got {entry['decidedBy']!r})")
check('history-tester' in entry['decidedBy'], "C: and the human label is preserved")

stop_daemon()
print("\nPASS")
