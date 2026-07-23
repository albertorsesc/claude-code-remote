#!/usr/bin/env python3
"""a message sent before the session emits system/init is LOST.
Compare: send immediately after spawn vs send after observing a real init event.

system/init only fires after the FIRST input, so "after init" cannot be tested
by waiting on init before sending anything, that loop can never resolve. Branch B
sends a throwaway warm-up message first to trigger init for real before the message
under test (the original version silently timed out at 60s and proceeded
anyway, so its conclusion rested on one clean arm instead of two)."""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect, INIT_WAIT_S


def run(label, wait_for_init, marker):
    try:
        os.remove(os.path.join(TB, marker))
    except FileNotFoundError:
        pass
    f, _device_id = pair_and_connect()
    sessions, approvals, inits = {}, [], []

    def rd():
        for line in f:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            t = ev.get('type')
            if t == 'session_list':
                for x in ev['sessions']:
                    sessions[x['id']] = x
            if t == 'session_update':
                sessions[ev['session']['id']] = ev['session']
            if t == 'approval_pending':
                approvals.append(ev['approval'])
            if t == 'stream':
                e = ev['event']
                if e.get('type') == 'system' and e.get('subtype') == 'init':
                    inits.append(ev['sessionId'])

    threading.Thread(target=rd, daemon=True).start()
    time.sleep(1)
    f.write(json.dumps({"type": "spawn", "cwd": TB, "label": label}) + "\n"); f.flush()
    t0 = time.time()
    sid = None
    while time.time() - t0 < 20:
        matches = [k for k, v in sessions.items() if v['label'] == label]
        if matches:
            sid = matches[0]
            break
        time.sleep(0.2)
    if sid is None:
        fail(f"[{label}] session never appeared after spawn")

    if wait_for_init:
        f.write(json.dumps({"type": "send", "sessionId": sid,
            "text": "reply with the single word: warmup"}) + "\n"); f.flush()
        t1 = time.time()
        while time.time() - t1 < INIT_WAIT_S and sid not in inits:
            time.sleep(0.2)
        observed = sid in inits
        print(f"  [{label}] init observed after {time.time() - t1:.1f}s: {observed}")
        if not observed:
            fail(f"[{label}] warm-up never triggered a real init event, test is not exercising 'after init'")
    else:
        print(f"  [{label}] sending immediately, init observed yet: {sid in inits}")

    f.write(json.dumps({"type": "send", "sessionId": sid,
        "text": f"Run exactly this bash command and nothing else: touch {marker}"}) + "\n"); f.flush()
    t2 = time.time()
    while time.time() - t2 < 75 and not approvals:
        time.sleep(0.3)
    got = bool(approvals)
    print(f"  [{label}] approval arrived: {got} (waited {time.time() - t2:.0f}s)")
    if got:
        f.write(json.dumps({"type": "decide", "toolUseId": approvals[0]['toolUseId'],
            "decision": "allow", "reason": "t", "by": "send_before_init"}) + "\n"); f.flush()
        time.sleep(8)
    return got, os.path.exists(os.path.join(TB, marker))


start_daemon('/tmp/v09.log')
print("=== A: send IMMEDIATELY after spawn (no init wait) ===")
a_appr, a_mark = run('immediate', False, 'IMMEDIATE_MARKER')
print("\n=== B: send AFTER a real init event ===")
b_appr, b_mark = run('afterinit', True, 'AFTERINIT_MARKER')

print(f"\n  A immediate: approval={a_appr} marker={a_mark}")
print(f"  B afterinit: approval={b_appr} marker={b_mark}")
check(a_appr and a_mark, "immediate send is not lost")
check(b_appr and b_mark, "post-init send is not lost")

stop_daemon()
print("\nPASS")
