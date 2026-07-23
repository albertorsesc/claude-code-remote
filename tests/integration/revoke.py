#!/usr/bin/env python3
"""the revoke command actually disconnects a live device and prevents it from
reconnecting, not just removing a row from the identity store. Zero API cost: no sessions
spawned, this only exercises pairing + the revoke command itself."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import check, fail, start_daemon, stop_daemon, pair_only, hello, raw_client

start_daemon('/tmp/v37.log')

print("=== setup: pair two devices ===")
fa, dev_a_priv, dev_a_pub, daemon_pub, dev_a_id = pair_only('revoke-requester')
channel_a, _ = hello(fa, dev_a_priv, daemon_pub, dev_a_id)
json.loads(next(iter(channel_a)))  # drain hello's own full-resync session_list

fb, dev_b_priv, dev_b_pub, _daemon_pub_b, dev_b_id = pair_only('revoke-target')
channel_b, _ = hello(fb, dev_b_priv, daemon_pub, dev_b_id)
json.loads(next(iter(channel_b)))  # same drain, every hello sends an unsolicited resync first

print("\n=== A: revoking an unknown deviceId replies with an error, disconnects nothing ===")
channel_a.write(json.dumps({"type": "revoke", "deviceId": "not-a-real-device"}) + "\n"); channel_a.flush()
resp = json.loads(next(iter(channel_a)))
check(resp.get('type') == 'error', "A: unknown deviceId replies with an error, not a false success")

print("\n=== B: device A revokes device B ===")
channel_a.write(json.dumps({"type": "revoke", "deviceId": dev_b_id}) + "\n"); channel_a.flush()
resp = json.loads(next(iter(channel_a)))
check(resp == {'type': 'revoked', 'deviceId': dev_b_id}, "B: revoker gets a confirmation")

print("\n=== C: device B's live connection is actually closed, not just marked stale ===")
closed = fb.readline() == ''
check(closed, "C: the revoked device's socket is closed by the daemon")

print("\n=== D: device B can no longer complete hello, it's really gone, not just disconnected ===")
fb2 = raw_client()
fb2.write(json.dumps({"type": "hello", "deviceId": dev_b_id}) + "\n"); fb2.flush()
resp2 = json.loads(fb2.readline())
check(resp2.get('type') == 'hello_failed', "D: revoked device is rejected on a fresh hello, same as a device that was never paired")

print("\n=== E: self-revoke delivers the confirmation BEFORE closing the socket ===")
# Device A revokes itself. The daemon must send `revoked` before disconnecting, or the requester
# never learns it worked (its own socket is the one being closed). Regression guard for a real
# bug: originally the daemon disconnected first, so `cc revoke <self>` printed nothing.
channel_a.write(json.dumps({"type": "revoke", "deviceId": dev_a_id}) + "\n"); channel_a.flush()
self_resp = json.loads(next(iter(channel_a)))
check(self_resp == {'type': 'revoked', 'deviceId': dev_a_id}, "E: self-revoke confirmation arrives before the disconnect")
check(fa.readline() == '', "E: the self-revoking device's own socket is then closed")

stop_daemon()
print("\nPASS")
