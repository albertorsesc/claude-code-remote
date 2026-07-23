#!/usr/bin/env python3
"""system/init is only emitted AFTER first user input (so a spawned-but-unused
       session never leaves 'starting' state in the fleet view).
and fail-closed on daemon crash, with errors surfaced."""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, DAEMON_PKILL_PATTERN, check, fail, start_daemon, stop_daemon, pair_and_connect, APPROVAL_WAIT_S, INIT_WAIT_S

start_daemon('/tmp/v10.log')
f, _device_id = pair_and_connect()
state, inits, approvals, errors = {}, [], [], []


def rd():
    for line in f:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get('type')
        if t == 'session_list':
            for x in ev['sessions']:
                state[x['id']] = x
        if t == 'session_update':
            state[ev['session']['id']] = ev['session']
        if t == 'approval_pending':
            approvals.append(ev['approval'])
        if t == 'error':
            errors.append(ev['message'])
        if t == 'stream':
            e = ev['event']
            if e.get('type') == 'system' and e.get('subtype') == 'init':
                inits.append((ev['sessionId'], e.get('session_id')))


threading.Thread(target=rd, daemon=True).start()
time.sleep(1)

print("=== does a spawned session initialise before input? ===")
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "initprobe"}) + "\n"); f.flush()
t0 = time.time()
sid = None
while time.time() - t0 < 15:
    matches = [k for k, v in state.items() if v['label'] == 'initprobe']
    if matches:
        sid = matches[0]
        break
    time.sleep(0.2)
if sid is None:
    fail("session never appeared after spawn")

time.sleep(25)
print(f"  after 25s idle: state={state[sid]['state']!r} claudeSessionId={state[sid]['claudeSessionId']!r} inits={len(inits)}")
pre_state, pre_inits = state[sid]['state'], len(inits)
check(pre_inits == 0, "no init event before any input")
check(pre_state == 'ready', "idle-but-unused session reports 'ready'")

f.write(json.dumps({"type": "send", "sessionId": sid, "text": "Reply with exactly: HI"}) + "\n"); f.flush()
t1 = time.time()
while time.time() - t1 < INIT_WAIT_S and len(inits) == pre_inits:
    time.sleep(0.2)
print(f"  after first input: inits={len(inits)} (took {time.time() - t1:.1f}s) state={state[sid]['state']!r}")
check(len(inits) > pre_inits, "init fires after first input")
print(f"  errors seen: {errors}")

print("\n=== retest: fail-closed on daemon crash ===")
try:
    os.remove(os.path.join(TB, 'CRASH_MARKER'))
except FileNotFoundError:
    pass
approvals.clear(); errors.clear()
f.write(json.dumps({"type": "send", "sessionId": sid,
    "text": "Run exactly this bash command and nothing else: touch CRASH_MARKER"}) + "\n"); f.flush()
t2 = time.time()
while time.time() - t2 < APPROVAL_WAIT_S and not approvals:
    time.sleep(0.3)
if not approvals:
    fail("approval never arrived, cannot exercise crash path")
print(f"  approval pending: True  errors: {errors}")

import subprocess
subprocess.run(DAEMON_PKILL_PATTERN, shell=True)
time.sleep(15)
check(not os.path.exists(os.path.join(TB, 'CRASH_MARKER')), "CRASH_MARKER absent, fail-closed held")

stop_daemon()
print("\nPASS")
