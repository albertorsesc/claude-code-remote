#!/usr/bin/env python3
"""pairing.ts's device registry had no cap before this, CC_MAX_PAIRED_DEVICES bounds it.
Also verifies a specific design claim made in index.ts's comment: the cap check happens before
the one-time pairing secret is touched, so a legitimate phone doesn't burn its secret on a
failure it can retry once capacity frees up. Zero API cost: pairing only, no sessions spawned."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import check, fail, start_daemon, stop_daemon, pair_only, raw_client, hello
import _crypto

start_daemon('/tmp/v38.log', extra_env={'CC_MAX_PAIRED_DEVICES': '2'})

print("=== A: pair up to the cap (2 devices), both succeed ===")
_f1, _p1, _pub1, daemon_pub, id1 = pair_only('cap-device-1')
check(bool(id1), "A: first device pairs successfully")
_f2, _p2, _pub2, _daemon_pub2, id2 = pair_only('cap-device-2')
check(bool(id2), "A: second device pairs successfully (at the cap)")

print("\n=== B: a third pairing attempt is rejected once the cap is reached ===")
f3 = raw_client()
device3_priv, device3_pub = _crypto.generate_identity()
device3_pub_b64 = _crypto.export_public_der_b64(device3_pub)

f3.write(json.dumps({"type": "begin_pair"}) + "\n"); f3.flush()
resp = json.loads(f3.readline())
qr = json.loads(resp['qr'])
secret = qr['s']
proof = _crypto.pairing_proof(secret, device3_pub_b64, qr['pk'])
f3.write(json.dumps({
    "type": "complete_pair", "devicePublicKey": device3_pub_b64,
    "deviceName": "cap-device-3", "proof": proof,
}) + "\n"); f3.flush()
resp3 = json.loads(f3.readline())
check(resp3.get('type') == 'pair_failed', "B: third device is rejected once the cap is reached")

print("\n=== C: the same one-time secret still works once capacity frees up (it wasn't burned by the cap rejection) ===")
_f1.close()  # drop device 1's connection, revoking it (below) is what actually frees the slot

channel2, _ = hello(_f2, _p2, daemon_pub, id2)
json.loads(next(iter(channel2)))  # drain the full-resync session_list (see hello()'s docstring)
channel2.write(json.dumps({"type": "revoke", "deviceId": id1}) + "\n"); channel2.flush()
revoke_resp = json.loads(next(iter(channel2)))
check(revoke_resp.get('type') == 'revoked', "C: revoking device 1 frees a slot")

f3.write(json.dumps({
    "type": "complete_pair", "devicePublicKey": device3_pub_b64,
    "deviceName": "cap-device-3", "proof": proof, # same proof, same never-burned secret
}) + "\n"); f3.flush()
resp3b = json.loads(f3.readline())
check(resp3b.get('type') == 'paired', "C: the same secret pairs successfully now that capacity exists")

stop_daemon()
print("\nPASS")
