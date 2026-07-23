#!/usr/bin/env python3
"""a spawned-but-unused session reports 'ready', not 'starting'.
it transitions ready -> working/idle on first input (no regression)."""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect

start_daemon('/tmp/v12.log')
f, _device_id = pair_and_connect()
state, seq = {}, []


def rd():
    for line in f:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'session_update':
            x = ev['session']
            state[x['id']] = x
            if x['label'] == 'readyprobe':
                seq.append(x['state'])


threading.Thread(target=rd, daemon=True).start()
time.sleep(1)
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "readyprobe"}) + "\n"); f.flush()
time.sleep(8)
matches = [k for k, v in state.items() if v['label'] == 'readyprobe']
if not matches:
    fail("session never appeared after spawn")
sid = matches[0]
st = state[sid]['state']
print(f"  spawned-unused state = {st!r}")
check(st == 'ready', "spawned-but-unused session reports 'ready'")

f.write(json.dumps({"type": "send", "sessionId": sid, "text": "Reply with exactly: OK"}) + "\n"); f.flush()
time.sleep(20)
print(f"  state sequence: {seq}")
final = state[sid]['state']
print(f"  after input state = {final!r}")
check(final in ('idle', 'working'), "session leaves 'ready' after first input")

stop_daemon()
print("\nPASS")
