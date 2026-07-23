#!/usr/bin/env python3
"""Crash recovery: after the daemon dies holding a live job, nothing may stay stuck 'running'.

The claude -p child dies with the daemon and there is no re-attach, so a job or session row left
mid-flight is never going to resolve itself. If reconciliation does not happen, a phone reconnecting
after a crash shows work that appears to still be in progress forever.

db.test.ts covers reconcileOrphaned* against hand-inserted rows. This covers the real path: rows
written by an actual running daemon, killed with SIGKILL so no shutdown handler runs, then recovered
by a fresh process against the same store.

Zero API cost: the session is spawned but never sent a message, so no tokens are consumed.
"""
import json
import os
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _crypto
from _lib import (TESTBED as TB, check, fail, start_daemon, stop_daemon,
                  pair_and_connect, DAEMON_ENTRY)

DB_PATH = tempfile.mktemp(prefix='cc-orphan-', suffix='.db')
STORE = tempfile.mktemp(prefix='cc-orphan-store-', suffix='.json')


def rows(state_col, table):
    c = sqlite3.connect(DB_PATH)
    try:
        return c.execute(f"SELECT {state_col} FROM {table}").fetchall()
    finally:
        c.close()


stop_daemon()
time.sleep(1)
start_daemon('/tmp/orphan_recovery_1.log', store=STORE, extra_env={'CC_DB_PATH': DB_PATH})

f, _device_id = pair_and_connect()
jobs, sessions = {}, []


def reader(fh):
    for line in fh:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'job_update':
            jobs[ev['job']['id']] = ev['job']
        if ev.get('type') == 'session_update':
            sessions.append(ev['session'])


threading.Thread(target=reader, args=(f,), daemon=True).start()
time.sleep(1)

print("=== spawn a real session (no send, so no API cost) ===")
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "orphan-victim"}) + "\n")
f.flush()
time.sleep(6)
live = [j for j in jobs.values() if j['state'] == 'running']
check(bool(live), f"a job is genuinely running before the crash (states: {[j['state'] for j in jobs.values()]})")
victim = live[0]

pre = rows('state', 'jobs')
print(f"  job rows before the crash: {[r[0] for r in pre]}")
check(any(r[0] == 'running' for r in pre), "the running job is persisted as 'running' in SQLite")

print("\n=== SIGKILL the daemon (no shutdown handler runs, a real crash) ===")
subprocess.run(f"pkill -9 -f '{DAEMON_ENTRY}'", shell=True)
subprocess.run("pkill -9 -f 'claude -p --input-format'", shell=True)
time.sleep(2)
mid = rows('state', 'jobs')
print(f"  job rows while the daemon is dead: {[r[0] for r in mid]}")
check(any(r[0] == 'running' for r in mid),
      "the row is still 'running' with nobody alive to finish it (this is the hazard)")

print("\n=== restart against the SAME store and database ===")
start_daemon('/tmp/orphan_recovery_2.log', store=STORE, extra_env={'CC_DB_PATH': DB_PATH})
time.sleep(1)

post = rows('state', 'jobs')
print(f"  job rows after restart: {[r[0] for r in post]}")
check(not any(r[0] == 'running' for r in post),
      "no job is left stuck in 'running' after recovery")
check(any(r[0] == 'failed' for r in post),
      "the orphaned job was reconciled to 'failed'")

sess_post = rows('final_state', 'sessions')
print(f"  session final_states after restart: {[r[0] for r in sess_post]}")
check(all(r[0] is not None for r in sess_post),
      "no session row is left without a final state")

with open('/tmp/orphan_recovery_2.log') as lf:
    logged = lf.read()
check('reconciled' in logged, "the daemon reported the reconciliation it performed")

print("\n=== what a client sees after reconnecting to the recovered daemon ===")
f2, _d2 = pair_and_connect()
jobs2 = {}


def reader2(fh):
    for line in fh:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'job_update':
            jobs2[ev['job']['id']] = ev['job']


threading.Thread(target=reader2, args=(f2,), daemon=True).start()
time.sleep(2)
stuck = [j for j in jobs2.values() if j['state'] == 'running']
print(f"  jobs presented to the client: {[(j['id'][:8], j['state']) for j in jobs2.values()]}")
check(not stuck,
      "a reconnecting client is never shown work that is silently dead (nothing stuck 'running')")
# the reconciled job must be VISIBLE, not merely not-running. The in-memory queue is
# empty on a fresh process, so the resync snapshot has to read recent jobs from the durable store,
# otherwise the phone that spawned this job is shown an empty list and the failure vanishes silently.
check(victim['id'] in jobs2 and jobs2[victim['id']]['state'] == 'failed',
      "the reconnecting client is SHOWN the reconciled 'failed' job (durable read side, not a silent vanish)")

stop_daemon()
for p in (DB_PATH, STORE):
    try:
        os.remove(p)
    except OSError:
        pass
print("\nPASS")
