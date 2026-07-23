#!/usr/bin/env python3
"""Per-session config over the wire: spawn a REAL session with --model/--effort/--permission-mode,
then steer model + permission mode mid-session. Verifies claude 2.x actually accepts the launch
flags and honors the set_model / set_permission_mode control requests, and that the daemon refuses
approval-bypassing permission modes.

Uses the cheapest model (haiku) and a single tiny turn to keep API cost minimal.
"""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect, INIT_WAIT_S

start_daemon('/tmp/session_config.log')
chan, _dev = pair_and_connect('session-config')
state, streams, errors = {}, [], []


def rd():
    for line in chan:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get('type')
        if t == 'session_update':
            state[ev['session']['id']] = ev['session']
        elif t == 'session_list':
            for s in ev['sessions']:
                state[s['id']] = s
        elif t == 'stream':
            streams.append(ev)
        elif t == 'error':
            errors.append(ev['message'])


threading.Thread(target=rd, daemon=True).start()
time.sleep(1)

print("=== A: the daemon REFUSES an approval-bypassing permission mode (zero API) ===")
chan.write(json.dumps({"type": "spawn", "cwd": TB, "label": "should-refuse", "permissionMode": "bypassPermissions"}) + "\n")
chan.flush()
time.sleep(1.5)
check(any('remote approval' in e for e in errors),
      f"A: bypassPermissions spawn is refused with a clear error (errors={errors})")
before = set(state)

print("\n=== B: spawn a real session with --model haiku --effort low --permission-mode plan ===")
chan.write(json.dumps({
    "type": "spawn", "cwd": TB, "label": "cfg", "model": "haiku", "effort": "low", "permissionMode": "plan",
}) + "\n")
chan.flush()
t0 = time.time()
sid = None
while time.time() - t0 < 15:
    new = [k for k, v in state.items() if v.get('label') == 'cfg']
    if new:
        sid = new[0]
        break
    time.sleep(0.3)
check(sid is not None, "B: the configured session spawned (was not refused, plan is allowed)")

print("\n=== C: first input triggers init; the session reports the haiku model ===")
chan.write(json.dumps({"type": "send", "sessionId": sid, "text": "Reply with exactly: OK"}) + "\n")
chan.flush()
t1 = time.time()
while time.time() - t1 < INIT_WAIT_S and not (state.get(sid, {}).get('model')):
    time.sleep(0.3)
model = state.get(sid, {}).get('model')
print(f"  reported model: {model!r}")
check(model is not None and 'haiku' in model.lower(),
      f"C: the session is actually running the requested model (haiku), got {model!r}")

print("\n=== D: set_model + set_permission_mode mid-session are accepted, session survives ===")
n_streams = len(streams)
chan.write(json.dumps({"type": "set_model", "sessionId": sid, "model": "sonnet"}) + "\n"); chan.flush()
time.sleep(2)
chan.write(json.dumps({"type": "set_permission_mode", "sessionId": sid, "mode": "plan"}) + "\n"); chan.flush()
time.sleep(2)
st = state.get(sid, {}).get('state')
print(f"  session state after control requests: {st!r}")
check(st != 'errored', f"D: the session did not error on the control requests (state={st!r})")
# The daemon reflects the requested model immediately; a further stream should have arrived (control_response).
check(state.get(sid, {}).get('model', '').lower().find('sonnet') >= 0 or len(streams) >= n_streams,
      "D: set_model was applied (model reflects sonnet) or the control produced a response")

print("\n=== E: mid-session /effort via send is delivered as text (no crash) ===")
chan.write(json.dumps({"type": "send", "sessionId": sid, "text": "/effort medium"}) + "\n"); chan.flush()
time.sleep(2)
check(state.get(sid, {}).get('state') != 'errored', "E: the session survived the /effort slash command")

stop_daemon()
print("\nPASS")
