#!/usr/bin/env python3
"""The control plane must survive one bad message.

Socket handlers run inside EventEmitter callbacks, so anything that throws while processing a
single message used to propagate as an uncaught exception and terminate the daemon, abandoning
every pending approval, orphaning every managed session, dropping every client. A duplicate
tool_use_id did exactly that (UNIQUE constraint failed: approvals.tool_use_id).

Zero API cost: speaks the hook bridge's line protocol directly instead of driving real sessions.

A: a duplicate approval_request does not kill the daemon.
B: the approval still works after the duplicate (survival isn't enough, it must still function).
C: the audit trail keeps the FIRST request, not a later overwrite.
D: malformed hook payloads don't kill it either.
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
import _crypto
from _lib import check, fail, start_daemon, stop_daemon, raw_client, pair_only, hello, CLIENT_SOCK

HOOK_SOCK = '/tmp/cc-daemon.sock'


def daemon_up():
    try:
        s = socket.socket(socket.AF_UNIX)
        s.connect(CLIENT_SOCK)
        s.close()
        return True
    except OSError:
        return False


def hook_send(payload):
    h = socket.socket(socket.AF_UNIX)
    h.connect(HOOK_SOCK)
    h.sendall((json.dumps(payload) + "\n").encode())
    return h


def approval_request(tool_use_id, tool_name='Bash', desc='first'):
    return {
        "kind": "approval_request",
        "event": {"tool_use_id": tool_use_id, "session_id": "sess-resilience",
                  "tool_name": tool_name, "tool_input": {"command": "true", "description": desc}},
    }


stop_daemon()
time.sleep(1)
DB_PATH = tempfile.mktemp(prefix='cc-resilience-', suffix='.db')
start_daemon('/tmp/daemon_resilience.log', extra_env={'CC_DB_PATH': DB_PATH})

f, priv, pub, dpub, dev = pair_only('resilience')
ch, _ = hello(f, priv, dpub, dev)
approvals = []


def reader():
    for line in f:
        try:
            ev = _crypto.open_frame(ch._key, json.loads(line))
        except Exception:
            continue
        if ev.get('type') == 'approval_pending':
            approvals.append(ev['approval'])


threading.Thread(target=reader, daemon=True).start()
time.sleep(0.5)

DUP = f"toolu_resilience_{int(time.time() * 1000)}"

print("=== A: a duplicate tool_use_id must not kill the daemon ===")
h1 = hook_send(approval_request(DUP, desc='first'))
time.sleep(1.2)
check(daemon_up(), "A: daemon alive after the first approval request")
h2 = hook_send(approval_request(DUP, desc='SECOND-should-not-overwrite'))
time.sleep(1.5)
check(daemon_up(), "A: daemon SURVIVED a duplicate tool_use_id (previously fatal)")

print("\n=== B: it still works afterwards (survival is not enough) ===")
FRESH = f"toolu_resilience_fresh_{int(time.time() * 1000)}"
h3 = hook_send(approval_request(FRESH, tool_name='Edit'))
time.sleep(1.5)
check(daemon_up(), "B: daemon alive after a subsequent request")
check(any(a['toolUseId'] == FRESH for a in approvals),
      "B: a NEW approval still reaches connected clients after the duplicate")

print("\n=== C: the audit trail keeps the first request, not a later overwrite ===")
# Read the DATABASE, not the broadcast stream. Asserting on the events would only prove that the
# first message sent arrived first, trivially true, and it would still pass if the insert were
# changed to an upsert. The property under test is that ON CONFLICT DO NOTHING preserved the
# original row, so the audit trail is the only place that can answer it.
check(bool([a for a in approvals if a['toolUseId'] == DUP]), "C: the original request was delivered")
conn = sqlite3.connect(DB_PATH)
try:
    row = conn.execute(
        "SELECT description, tool_name FROM approvals WHERE tool_use_id = ?", (DUP,)
    ).fetchall()
finally:
    conn.close()
check(len(row) == 1, f"C: the duplicate produced exactly ONE persisted row (got {len(row)})")
check(row[0][0] == 'first',
      f"C: the persisted row still holds the FIRST request's content (got {row[0][0]!r}), "
      "a later request must not rewrite an earlier one's audit record")

print("\n=== D: malformed hook payloads don't kill it either ===")
for bad in [
    {"kind": "approval_request"},                                   # no event at all
    {"kind": "approval_request", "event": None},                    # null event
    {"kind": "approval_request", "event": {"tool_use_id": None}},   # null id -> fallback path
    {"kind": "approval_request", "event": {"tool_input": "not-an-object"}},
]:
    try:
        hook_send(bad)
    except OSError:
        pass
    time.sleep(0.4)
check(daemon_up(), "D: daemon survived a sweep of malformed hook payloads")

for h in (h1, h2, h3):
    try:
        h.close()
    except OSError:
        pass
stop_daemon()
print("\nPASS")
