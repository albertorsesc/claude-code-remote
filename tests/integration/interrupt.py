#!/usr/bin/env python3
"""`interrupt`, a shipped client command with, until now, zero test coverage.

It writes a control_request to the session's stdin. The properties that matter are not "the model
stopped mid-sentence" (unobservable and timing-dependent) but the ones a user depends on:

A: interrupting an unknown session is a clean error, not a crash. (no API cost)
B: interrupting a LIVE session does not kill it or the daemon.
C: the session still accepts work AFTER being interrupted, an interrupt that wedges the session
   would be worse than no interrupt at all.

Costs real API tokens: C requires the session to actually respond after the interrupt.
"""
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import (TESTBED as TB, APPROVAL_WAIT_S, check, fail, start_daemon, stop_daemon,
                  pair_and_connect, wait_for, CLIENT_SOCK)


def daemon_up():
    try:
        s = socket.socket(socket.AF_UNIX)
        s.connect(CLIENT_SOCK)
        s.close()
        return True
    except OSError:
        return False


stop_daemon()
time.sleep(1)
start_daemon('/tmp/interrupt.log')

f, _device_id = pair_and_connect()
sessions, approvals, errors = [], [], []


def reader(fh):
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
        if t == 'error':
            errors.append(ev['message'])


threading.Thread(target=reader, args=(f,), daemon=True).start()
time.sleep(1)

print("=== A: interrupting an unknown session is a clean error ===")
f.write(json.dumps({"type": "interrupt", "sessionId": "does-not-exist"}) + "\n")
f.flush()
check(wait_for(lambda: any('does-not-exist' in e for e in errors), timeout=10),
      f"A: unknown session id produces an error to the caller (errors: {errors})")
check(daemon_up(), "A: the daemon survived an interrupt for a session that does not exist")

print("\n=== B: interrupt a live session ===")
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "interruptible"}) + "\n")
f.flush()
check(wait_for(lambda: any(s.get('label') == 'interruptible' for s in sessions), timeout=30),
      "B: the session was spawned")
sid = [s for s in sessions if s.get('label') == 'interruptible'][0]['id']

# Give it real work so the interrupt lands on a session that is actually busy.
f.write(json.dumps({"type": "send", "sessionId": sid,
                    "text": "Count from 1 to 40, one number per line, with no other text."}) + "\n")
f.flush()
time.sleep(4)

f.write(json.dumps({"type": "interrupt", "sessionId": sid}) + "\n")
f.flush()
time.sleep(6)
check(daemon_up(), "B: the daemon survived interrupting a live session")
states = [s.get('state') for s in sessions if s.get('id') == sid]
print(f"  session states observed: {states}")
check(not any(s == 'errored' for s in states),
      f"B: interrupting did not put the session into an errored state ({states})")

print("\n=== C: the session still works after being interrupted ===")
approvals.clear()
f.write(json.dumps({"type": "send", "sessionId": sid,
                    "text": "Run exactly this bash command and nothing else: touch INTERRUPT_MARKER"}) + "\n")
f.flush()
if not wait_for(lambda: bool(approvals)):
    fail("C: the session never responded after being interrupted, interrupt wedged it "
         f"(states seen: {states}; see /tmp/interrupt.log for session stderr)")
print(f"  approval after interrupt: {approvals[0]['toolName']}")
check(True, "C: the session accepted and acted on new input after the interrupt")

f.write(json.dumps({"type": "decide", "toolUseId": approvals[0]['toolUseId'], "decision": "deny",
                    "reason": "test only needed the approval to prove liveness", "by": "interrupt-test"}) + "\n")
f.flush()
time.sleep(3)
check(daemon_up(), "the daemon is healthy at the end")

stop_daemon()
print("\nPASS")
