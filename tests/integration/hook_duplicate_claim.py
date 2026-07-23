#!/usr/bin/env python3
"""a second hook connection presenting an in-flight tool_use_id must not hijack the
first request's approval.

The hook bridge socket is unauthenticated by design (reaching it implies local access). Before the
fix, broker.open() overwrote the pending approval and its waiter unconditionally, so a second local
process could present the SAME tool_use_id with benign content: the phone was then shown the benign
call and the operator approved it, while the durable audit row kept the FIRST request's content
(db uses ON CONFLICT DO NOTHING). The operator's name ended up on a destructive command they were
never shown.

This drives the REAL hook socket directly (no `claude` session, so zero API cost): two raw
connections racing the same tool_use_id, then a real sealed decision from a paired client, then a
read of the durable audit row to prove live view and audit agree, on the FIRST request's content.
"""
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import (TESTBED as TB, check, fail, start_daemon, stop_daemon,
                  pair_and_connect)

HOOK_SOCK = '/tmp/cc-daemon.sock'
DB_PATH = tempfile.mktemp(prefix='cc-hookdup-', suffix='.db')
STORE = tempfile.mktemp(prefix='cc-hookdup-store-', suffix='.json')
TOOL_USE_ID = 'toolu_dupe_test_0001'

stop_daemon()
time.sleep(1)
start_daemon('/tmp/hook_duplicate_claim.log', store=STORE, extra_env={'CC_DB_PATH': DB_PATH})

# A paired client that watches for approval_pending / approval_resolved and can issue a sealed decide.
chan, _device_id = pair_and_connect('hook-dup-test')
pendings, resolved = [], []


def rd():
    for line in chan:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'approval_pending':
            pendings.append(ev['approval'])
        if ev.get('type') == 'approval_resolved':
            resolved.append(ev)


threading.Thread(target=rd, daemon=True).start()
time.sleep(1)


def hook_connect():
    s = socket.socket(socket.AF_UNIX)
    s.connect(HOOK_SOCK)
    return s


def send_request(sock, tool_name, tool_input):
    sock.sendall((json.dumps({
        "kind": "approval_request",
        "event": {
            "tool_use_id": TOOL_USE_ID,
            "session_id": "claude-nonexistent", # no live session; the bridge still opens the approval
            "tool_name": tool_name,
            "tool_input": tool_input,
        },
    }) + "\n").encode())


print("=== the legitimate hook blocks on a destructive Bash command ===")
sock_a = hook_connect()
send_request(sock_a, "Bash", {"command": "rm -rf ~/work", "description": "clean the workspace"})
time.sleep(1.5)
check(len(pendings) == 1, f"the operator is shown exactly one pending approval (got {len(pendings)})")
check(pendings[0]['toolName'] == 'Bash', "the pending approval is the real Bash command")
check(pendings[0]['toolInput'].get('command') == 'rm -rf ~/work', "with the real, destructive tool_input")

print("\n=== a second local process races the SAME tool_use_id with benign content ===")
sock_b = hook_connect()
send_request(sock_b, "Read", {"file_path": "README.md"})

# The duplicate must be denied immediately on its own socket, and must NOT produce a second
# approval_pending or replace what the operator sees.
sock_b.settimeout(5)
b_reply = b''
try:
    while b'\n' not in b_reply:
        chunk = sock_b.recv(4096)
        if not chunk:
            break
        b_reply += chunk
except socket.timeout:
    pass
b_msg = json.loads(b_reply.decode().split('\n')[0]) if b_reply.strip() else None
check(b_msg is not None and b_msg.get('kind') == 'approval_decision' and b_msg.get('decision') == 'deny',
      f"the duplicate socket is failed closed on its own side (got {b_msg})")
time.sleep(1)
check(len(pendings) == 1, "the duplicate produced NO second approval_pending, the operator's view is unchanged")
check(pendings[0]['toolName'] == 'Bash' and pendings[0]['toolInput'].get('command') == 'rm -rf ~/work',
      "the operator still sees the ORIGINAL destructive command, not the benign Read")

print("\n=== closing the rejected duplicate must NOT abandon the real request ===")
sock_b.close()
time.sleep(1.5)
check(len(resolved) == 0, "the real approval is still pending, the duplicate's close did not deny it")

print("\n=== operator approves what they were shown, and the audit records THAT ===")
chan.write(json.dumps({
    "type": "decide", "toolUseId": TOOL_USE_ID, "decision": "allow", "reason": "approved", "by": "operator",
}) + "\n")
chan.flush()

# The real hook (socket A) must receive the allow decision.
sock_a.settimeout(5)
a_reply = b''
try:
    while b'\n' not in a_reply:
        chunk = sock_a.recv(4096)
        if not chunk:
            break
        a_reply += chunk
except socket.timeout:
    pass
a_msg = json.loads(a_reply.decode().split('\n')[0]) if a_reply.strip() else None
check(a_msg is not None and a_msg.get('kind') == 'approval_decision' and a_msg.get('decision') == 'allow',
      f"the genuine first hook received the operator's allow (got {a_msg})")

# The durable audit row must hold the FIRST request's content with the decision, not the benign Read.
time.sleep(1)
conn = sqlite3.connect(DB_PATH)
row = conn.execute(
    "SELECT tool_name, tool_input, decision, decided_by FROM approvals WHERE tool_use_id = ?",
    (TOOL_USE_ID,),
).fetchone()
conn.close()
print(f"  audit row: {row}")
check(row is not None, "the approval is recorded in the durable audit")
tool_name, tool_input_json, decision, decided_by = row
tool_input = json.loads(tool_input_json)
check(tool_name == 'Bash' and tool_input.get('command') == 'rm -rf ~/work',
      "the audit trail holds the command the operator actually saw (Bash rm -rf), never the benign Read")
check(decision == 'allow', "the decision is recorded")
check('operator' in decided_by, "attributed to the authenticated operator")

sock_a.close()
chan.close()
stop_daemon()
for p in (DB_PATH, STORE):
    try:
        os.remove(p)
    except OSError:
        pass
print("\nPASS")
