#!/usr/bin/env python3
"""the approval audit trail survives a daemon restart. This is the one assertion nothing
about the old in-memory design could ever produce, approvals.ts drops a decided approval from
memory 60s after decision, and everything's gone on restart regardless. Drives one real approval
(same proven pattern as skeleton_regression.py), kills the daemon, then reopens the SQLite
file directly with Python's stdlib sqlite3 to prove the decision is actually durable."""
import json
import os
import sqlite3
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect, APPROVAL_WAIT_S

DB_PATH = '/tmp/cc-audit-trail-test.db'
for p in (DB_PATH, os.path.join(TB, 'AUDIT_MARKER')):
    try:
        os.remove(p)
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


print("=== driving one real approval through to a decision ===")
start_daemon('/tmp/v32-audit.log', extra_env={'CC_DB_PATH': DB_PATH})
f, device_id = pair_and_connect("audit-trail-test")
sessions, approvals = [], []
threading.Thread(target=reader, args=(f, sessions, approvals), daemon=True).start()
time.sleep(1)

f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "audit"}) + "\n"); f.flush()
time.sleep(5)
sid = [s for s in sessions if s['label'] == 'audit'][0]['id']
f.write(json.dumps({"type": "send", "sessionId": sid,
    "text": "Run exactly this bash command and nothing else: touch AUDIT_MARKER"}) + "\n"); f.flush()

t0 = time.time()
while time.time() - t0 < APPROVAL_WAIT_S and not approvals:
    time.sleep(0.3)
if not approvals:
    fail("no approval arrived, cannot test the audit trail")
a = approvals[0]
f.write(json.dumps({"type": "decide", "toolUseId": a['toolUseId'], "decision": "allow",
    "reason": "audit-trail-regression", "by": "audit-tester"}) + "\n"); f.flush()
time.sleep(5)
check(os.path.exists(os.path.join(TB, 'AUDIT_MARKER')), "the approval actually ran (sanity check before the real assertion)")

print("\n=== killing the daemon and reopening the DB file directly ===")
stop_daemon()
time.sleep(1)

conn = sqlite3.connect(DB_PATH)
row = conn.execute(
    "SELECT tool_name, decision, reason, decided_by FROM approvals WHERE tool_use_id = ?",
    (a['toolUseId'],),
).fetchone()
conn.close()

check(row is not None, "the decided approval's row exists in SQLite after the daemon is dead")
if row:
    tool_name, decision, reason, decided_by = row
    check(tool_name == a['toolName'], "durable row has the correct tool_name")
    check(decision == 'allow', "durable row has the correct decision")
    check(reason == 'audit-trail-regression', "durable row has the correct reason")
    # decided_by is now `<authenticated deviceId> (<client label>)`: the client's label alone was
    # forgeable, so the device that actually sent the decision is recorded ahead of it.
    check(decided_by.startswith(device_id),
          f"durable row attributes the decision to the AUTHENTICATED device (got {decided_by!r})")
    check('audit-tester' in decided_by, "and still carries the human label for context")

print("\nPASS")
