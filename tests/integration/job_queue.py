#!/usr/bin/env python3
"""the job queue actually queues under a concurrency cap, actually audits refusals (not
just successes), and actually advances the queue when capacity frees up. No `send`, killing the
real `claude` child process directly (SIGTERM) triggers a genuine exit at zero API cost, same
pattern skeleton_regression.py already uses for its daemon-crash test."""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import ROOT, TESTBED as TB, check, fail, start_daemon, stop_daemon, pair_and_connect

DB_PATH = '/tmp/cc-job-queue-test.db'
try:
    os.remove(DB_PATH)
except FileNotFoundError:
    pass

start_daemon('/tmp/v32-jobs.log', extra_env={'CC_MAX_CONCURRENT_SESSIONS': '1', 'CC_DB_PATH': DB_PATH})

f, _device_id = pair_and_connect('job-queue-test')
jobs = {}


def rd():
    for line in f:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'job_update':
            jobs[ev['job']['id']] = ev['job']


import threading
threading.Thread(target=rd, daemon=True).start()
time.sleep(0.5)

print("=== A: two spawns under CC_MAX_CONCURRENT_SESSIONS=1 ===")
f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "job-a"}) + "\n"); f.flush()
time.sleep(3)
job_a = next((j for j in jobs.values() if j['cwd'] == TB and j['state'] in ('running', 'queued')), None)
if not job_a:
    fail("A: no job appeared for the first spawn")
check(job_a['state'] == 'running', "A: first job runs immediately (under cap)")

f.write(json.dumps({"type": "spawn", "cwd": TB, "label": "job-b"}) + "\n"); f.flush()
time.sleep(2)
job_b = next((j for j in jobs.values() if j['id'] != job_a['id'] and j['cwd'] == TB), None)
if not job_b:
    fail("A: no job appeared for the second spawn")
check(job_b['state'] == 'queued', "A: second job stays queued while the first is running (cap=1)")

print("\n=== B: killing the running session's process frees capacity for the queued job ===")
subprocess.run("pkill -f 'claude -p --input-format'", shell=True)
t0 = time.time()
while time.time() - t0 < 30 and jobs.get(job_b['id'], {}).get('state') == 'queued':
    time.sleep(0.3)
check(jobs[job_a['id']]['state'] == 'failed', "B: first job transitions to failed on process death")
check(jobs[job_b['id']]['state'] == 'running', "B: second job starts once capacity frees up")

print("\n=== C: a refused spawn (bad project) is audited in the DB, not just successes ===")
import tempfile
badproj = tempfile.mkdtemp(prefix='cc-job-queue-noproj-')
f.write(json.dumps({"type": "spawn", "cwd": badproj, "label": "job-bad"}) + "\n"); f.flush()
time.sleep(1.5)
job_bad = next((j for j in jobs.values() if j['cwd'] == badproj), None)
check(job_bad is not None and job_bad['state'] == 'failed', "C: refused spawn recorded as a failed job")

stop_daemon()

print("\n=== D: verifying directly against the DB file (not just the live event stream) ===")
import sqlite3
conn = sqlite3.connect(DB_PATH)
row = conn.execute("SELECT state, error FROM jobs WHERE id = ?", (job_bad['id'],)).fetchone()
check(row is not None and row[0] == 'failed' and 'refusing to spawn' in row[1],
      "D: the refused job's row persists in SQLite with the margin-check reason")
conn.close()

print("\nPASS")
