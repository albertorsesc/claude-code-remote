#!/usr/bin/env python3
"""Remote pairing via an out-of-band code (restores what the self-service lockdown had to disable for safety).

A CLI on a SECOND machine cannot ask the daemon for a secret over the network, begin_pair is
local-only, or reaching the port would be enough to become a trusted device. Instead the operator
mints a code ON the daemon machine (`cc pair-code`, a local begin_pair) and carries it by hand to the
second machine, which redeems it with `CC_PAIR_CODE=<code> cc pair` straight into complete_pair over
the network. The secret is never disclosed over the wire.

This drives the REAL cc.ts for both halves (mint + redeem) against a real daemon, then proves the
newly-paired remote device can drive a sealed command over TCP. Zero API cost: no session is spawned.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import ROOT, check, fail, start_daemon, stop_daemon

CLI = os.path.join(ROOT, 'packages/cli/src/cc.ts')
PORT = 7462
REMOTE_STORE = tempfile.mktemp(prefix='cc-remote-device-', suffix='.json')

stop_daemon()
time.sleep(1)
start_daemon('/tmp/remote_pair_code.log', extra_env={
    'CC_CLIENT_TCP_PORT': str(PORT), 'CC_CLIENT_TCP_HOST': '127.0.0.1',
})
time.sleep(1)


def run_cli(args, env_extra=None, timeout=25):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(['node', CLI, *args], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=timeout)


print("=== A: mint a pairing code on the daemon machine (local begin_pair, never over TCP) ===")
mint = run_cli(['pair-code'])
print(mint.stdout.strip())
if mint.stderr.strip():
    print("  stderr:", mint.stderr.strip())
check(mint.returncode == 0, "A: `cc pair-code` exits cleanly on the daemon machine")
m = re.search(r"CC_PAIR_CODE='([^']+)'", mint.stdout)
check(m is not None, "A: it prints a redeemable CC_PAIR_CODE line for the second machine")
code = m.group(1)
# The secret itself must not be printed in the clear as a standalone field, it rides inside the
# opaque code only. (The code is base64url of the QR payload; that is the out-of-band channel.)
check(re.search(r"CC_CLIENT_TCP_ADDR=127\.0\.0\.1:%d" % PORT, mint.stdout) is not None,
      "A: it tells the operator the daemon's reachable tcp address")

print("\n=== B: redeem the code on a SECOND machine over TCP (complete_pair, no begin_pair) ===")
redeem = run_cli(['pair'], env_extra={'CC_PAIR_CODE': code, 'CC_DEVICE_STORE': REMOTE_STORE})
print("  ", redeem.stdout.strip().replace("\n", "\n   "))
if redeem.stderr.strip():
    print("  stderr:", redeem.stderr.strip())
check(redeem.returncode == 0, "B: the second machine pairs successfully with the out-of-band code")
check('paired. deviceId=' in redeem.stdout, "B: it reports the new deviceId")

check(os.path.exists(REMOTE_STORE), "B: the remote device record was written")
rec = json.load(open(REMOTE_STORE))
for field in ('deviceId', 'devicePrivateKey', 'devicePublicKey', 'daemonPublicKey'):
    check(field in rec and rec[field], f"B: device.json has {field}")

print("\n=== C: the same code cannot be redeemed twice (one-time secret) ===")
again = run_cli(['pair'], env_extra={'CC_PAIR_CODE': code, 'CC_DEVICE_STORE': tempfile.mktemp(suffix='.json')})
check(again.returncode != 0, "C: a second redemption of a burned code is refused")
check('pairing failed' in again.stderr.lower() or 'pairing failed' in again.stdout.lower(),
      "C: with a clear 'pairing failed' message")

print("\n=== D: the newly-paired remote device can drive a sealed command over TCP ===")
# `history` is a one-shot read: it sends a sealed command and exits on the reply, so it proves the
# full authenticated path (hello -> session key -> sealed command -> sealed reply) works end to end.
hist = run_cli(['history'], env_extra={
    'CC_CLIENT_TCP_ADDR': f'127.0.0.1:{PORT}', 'CC_DEVICE_STORE': REMOTE_STORE,
})
print("  history output:", hist.stdout.strip())
if hist.stderr.strip():
    print("  stderr:", hist.stderr.strip())
check(hist.returncode == 0, "D: `cc history` succeeds from the remote device over TCP")
check('APPROVAL HISTORY' in hist.stdout or 'no decided approvals' in hist.stdout,
      "D: it gets a real approval_history reply back (hello + sealed command both worked)")

print("\n=== E: a decoy/garbage code is rejected cleanly, not with a stack trace ===")
bad = run_cli(['pair'], env_extra={'CC_PAIR_CODE': 'totally-bogus-code', 'CC_DEVICE_STORE': tempfile.mktemp(suffix='.json')})
check(bad.returncode != 0, "E: a bogus CC_PAIR_CODE fails")
check('pairing code' in bad.stderr.lower(), "E: with a helpful message, not a crash")

stop_daemon()
for p in (REMOTE_STORE,):
    try:
        os.remove(p)
    except OSError:
        pass
print("\nPASS")
