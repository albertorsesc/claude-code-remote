#!/usr/bin/env python3
"""The audit trail is a SECOND trust record (read during an incident), and a decision's `by`/`reason`
are controlled by an authenticated-but-untrusted paired device. An embedded newline or ANSI escape in
them must not forge a whole `cc history` row or drive the reviewing terminal, the same guarantee the
daemon's operator log already gives. This drives the REAL cc.ts `history` render
against a daemon whose durable store holds a decided approval with control chars in reason/decided_by.

Zero API cost: the malicious approval row is inserted directly into the durable DB, then read back
over the real protocol and rendered by the real CLI, exactly the incident-review path.
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import ROOT, check, fail, start_daemon, stop_daemon

CLI = os.path.join(ROOT, 'packages/cli/src/cc.ts')
DB_PATH = tempfile.mktemp(prefix='cc-audit-inject-', suffix='.db')
STORE = tempfile.mktemp(prefix='cc-audit-inject-store-', suffix='.json')
DEVICE_STORE = tempfile.mktemp(prefix='cc-audit-inject-device-', suffix='.json')

# A decision whose reason and decided_by try to forge a second, benign-looking audit row.
FORGED_ROW = '2099-01-01 00:00:00  ALLOW Bash       trusted-admin/cli'
EVIL_REASON = f'nope\n  {FORGED_ROW}  "looks legit"'
EVIL_BY = 'deadbeef (attacker/cli)\x1b[2K'  # ANSI erase-line, to try to wipe the reviewer's terminal

stop_daemon()
time.sleep(1)
# Seed the durable store BEFORE the daemon opens it, with one decided approval carrying the payload.
os.makedirs(os.path.dirname(DB_PATH) or '.', exist_ok=True)
conn = sqlite3.connect(DB_PATH)
conn.executescript("""
CREATE TABLE IF NOT EXISTS approvals (
  tool_use_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL, description TEXT, requested_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  decision TEXT, reason TEXT, decided_by TEXT, decided_at INTEGER);
""")
conn.execute(
    "INSERT INTO approvals (tool_use_id, session_id, tool_name, tool_input, requested_at, deadline_at, decision, reason, decided_by, decided_at) "
    "VALUES (?,?,?,?,?,?,?,?,?,?)",
    ('tu-evil', 's1', 'Read', '{}', 1000, 2000, 'deny', EVIL_REASON, EVIL_BY, 1500),
)
conn.commit()
conn.close()

start_daemon('/tmp/audit_render_injection.log', store=STORE, extra_env={'CC_DB_PATH': DB_PATH})
time.sleep(1)


def run_cli(args, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(['node', CLI, *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=25)


print("=== pair a CLI device locally ===")
pair = run_cli(['pair'], env_extra={'CC_DEVICE_STORE': DEVICE_STORE})
check(pair.returncode == 0 and 'paired' in pair.stdout, f"paired ({pair.stdout.strip()[:50]} / {pair.stderr.strip()[:80]})")

print("\n=== cc history renders the seeded decision, with control chars NEUTRALIZED ===")
hist = run_cli(['history'], env_extra={'CC_DEVICE_STORE': DEVICE_STORE})
out = hist.stdout
print("  --- rendered history ---")
for line in out.splitlines():
    print("  |", repr(line))
check(hist.returncode == 0, "cc history exits cleanly")
check('APPROVAL HISTORY' in out, "the decided approval is shown")

# The load-bearing checks: no raw control char reaches the terminal, and the forged row does not
# appear as its own standalone line.
data_lines = [ln for ln in out.splitlines() if ln.strip() and 'APPROVAL HISTORY' not in ln]
check(all('\x1b' not in ln for ln in out.splitlines()), "no raw ESC (ANSI) survives into the rendered audit")
check('\\n' in out, "the injected newline is shown as a visible \\n escape, not a real line break")
forged_standalone = any(ln.strip() == FORGED_ROW.strip() or ln.strip().startswith('2099-01-01') for ln in data_lines)
check(not forged_standalone, "the forged '2099-...' row never renders as its own genuine-looking history line")

stop_daemon()
for p in (DB_PATH, STORE, DEVICE_STORE):
    try:
        os.remove(p)
    except OSError:
        pass
print("\nPASS")
