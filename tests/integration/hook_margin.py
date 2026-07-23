#!/usr/bin/env python3
"""The daemon refuses to spawn a session unless the target project's settings.json
proves a safe margin between the hook `timeout` and the bridge's self-deny."""
import json
import os
import shutil
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import ROOT, TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect

WORKDIR = tempfile.mkdtemp(prefix='cc-hook-margin-')
NOHOOK = os.path.join(WORKDIR, 'nohook')
TIGHT = os.path.join(WORKDIR, 'tightmargin')
os.makedirs(NOHOOK)
os.makedirs(os.path.join(TIGHT, '.claude'))
with open(os.path.join(TIGHT, '.claude', 'settings.json'), 'w') as fh:
    json.dump({
        "hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{
            "type": "command",
            "command": f"/usr/bin/env node {os.path.join(ROOT, 'hook', 'approve-bridge.mjs')}",
            "timeout": 20,
        }]}]},
    }, fh)

SELF_DENY_MS = 1200000
start_daemon('/tmp/v14.log', self_deny_ms=SELF_DENY_MS)

f, _device_id = pair_and_connect()
errors = []


def rd():
    for line in f:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'error':
            errors.append(ev['message'])


threading.Thread(target=rd, daemon=True).start()
time.sleep(0.5)


def spawn(cwd, label):
    errors.clear()
    f.write(json.dumps({"type": "spawn", "cwd": cwd, "label": label}) + "\n"); f.flush()
    time.sleep(1.5)
    return list(errors)


print("=== A: testbed (installed hook, 1800s timeout, ample margin) ===")
errs = spawn(TB, 'p3-ok')
print(f"  refused: {bool(errs)}  errors: {errs}")
check(not errs, "safe project spawns without a refusal")

print("\n=== B: no .claude/settings.json at all ===")
errs = spawn(NOHOOK, 'p3-nohook')
print(f"  refused: {bool(errs)}  errors: {errs}")
check(bool(errs), "project with no bridge hook is refused")

print("\n=== C: hook installed but timeout (20s) is below self-deny (1200s) ===")
errs = spawn(TIGHT, 'p3-tight')
print(f"  refused: {bool(errs)}  errors: {errs}")
check(bool(errs), "project with too-tight a margin is refused")

stop_daemon()
shutil.rmtree(WORKDIR, ignore_errors=True)
print("\nPASS")
