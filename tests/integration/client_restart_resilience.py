#!/usr/bin/env python3
"""A long-lived client must survive a daemon restart. Drives the REAL cc CLI, not a simulation.

The daemon's per-device sequence lives in memory and begins again at 1 in a fresh process. The
client's inbound dedup, by contrast, persists across reconnects on purpose (it is also the resume
checkpoint). So after a restart the client's watermark described a sequence space that no longer
existed, and it rejected the entire resync, and every event after it, as stale duplicates.

The failure mode was the dangerous kind: `cc watch` reconnected, printed "[reconnected, resynced]",
and then rendered nothing forever. A client that reports health while blind is worse than one that
visibly fails.

Zero API cost: spawns target a directory with no .claude/settings.json, so they are refused by the
margin check and no session ever runs.
"""
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import ROOT, check, fail, DAEMON_ENTRY

CLI = os.path.join(ROOT, 'packages/cli/src/cc.ts')
ENV = {
    **os.environ,
    'CC_STORE': tempfile.mktemp(prefix='cc-restart-daemon-', suffix='.json'),
    'CC_DB_PATH': tempfile.mktemp(prefix='cc-restart-', suffix='.db'),
    'CC_CLIENT_SOCK': '/tmp/cc-restart-client.sock',
    'CC_DAEMON_SOCK': '/tmp/cc-restart-hook.sock',
    'CC_DEVICE_STORE': tempfile.mktemp(prefix='cc-restart-device-', suffix='.json'),
}
BAD = tempfile.mkdtemp(prefix='cc-restart-noproj-')   # no hook installed -> spawn refused
WATCH_LOG = '/tmp/cc-restart-watch.log'


def start_daemon(log):
    p = subprocess.Popen(f"node {DAEMON_ENTRY}", shell=True, cwd=ROOT, env=ENV,
                         stdout=open(log, 'w'), stderr=subprocess.STDOUT)
    time.sleep(3)
    return p


def cli(*args):
    return subprocess.run(f"node {CLI} {' '.join(args)}", shell=True, cwd=ROOT, env=ENV,
                          capture_output=True, text=True, timeout=60)


def rendered(label):
    with open(WATCH_LOG) as fh:
        return fh.read().count(label)


subprocess.run(f"pkill -f '{DAEMON_ENTRY}'", shell=True)
time.sleep(1)
for p in (ENV['CC_CLIENT_SOCK'], ENV['CC_DAEMON_SOCK']):
    try:
        os.remove(p)
    except OSError:
        pass

start_daemon('/tmp/cc-restart-daemon1.log')
r = cli('pair')
check('paired' in r.stdout, f"the CLI paired with the daemon ({r.stdout.strip()[:60]})")

watch = subprocess.Popen(f"node {CLI} watch", shell=True, cwd=ROOT, env=ENV,
                         stdout=open(WATCH_LOG, 'w'), stderr=subprocess.STDOUT)
time.sleep(3)

try:
    print("=== baseline: an event reaches the watcher before any restart ===")
    cli('spawn', BAD, 'before-restart')
    time.sleep(3)
    check(rendered('before-restart') > 0, "the watcher renders events from the original daemon")

    print("\n=== restart the daemon; the watcher process keeps running ===")
    subprocess.run(f"pkill -f '{DAEMON_ENTRY}'", shell=True)
    time.sleep(2)
    start_daemon('/tmp/cc-restart-daemon2.log')
    time.sleep(7)   # the client reconnects on its own backoff schedule

    print("=== an event AFTER the restart must still reach the watcher ===")
    cli('spawn', BAD, 'after-restart')
    time.sleep(5)
    got = rendered('after-restart')
    if got == 0:
        with open(WATCH_LOG) as fh:
            tail = ''.join(fh.readlines()[-6:])
        fail("the watcher went blind after the daemon restarted, it reconnected and rendered "
             f"nothing. Watch output tail:\n{tail}")
    check(got > 0, "the watcher still renders events after a daemon restart")

    with open(WATCH_LOG) as fh:
        log = fh.read()
    check('reconnected' in log, "and it did genuinely reconnect rather than never dropping")
finally:
    watch.kill()
    subprocess.run(f"pkill -f '{DAEMON_ENTRY}'", shell=True)
    for p in (ENV['CC_CLIENT_SOCK'], ENV['CC_DAEMON_SOCK']):
        try:
            os.remove(p)
        except OSError:
            pass

print("\nPASS")
