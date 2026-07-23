#!/usr/bin/env python3
"""Trust may only be BOOTSTRAPPED locally; it may be USED from anywhere.

`begin_pair` returns the one-time secret to its caller. Serving that on the network listener made
pairing self-service: anything able to reach the port could mint a secret, compute the proof itself,
and become a trusted device, and a trusted device can spawn sessions and approve tool calls, i.e.
execute code on this machine. Reachability is not authorisation.

The rule is therefore: begin_pair is local-only. Everything else still works over the network, so
the real phone flow is untouched, the QR is displayed on this machine, the phone reads it with its
camera, and completes pairing over the tailnet.

A: begin_pair over TCP is refused (the exploit).
B: begin_pair over the local socket still works.
C: a secret obtained LOCALLY completes pairing over TCP (the actual phone flow, out of band).
D: that device then drives sealed commands over TCP.

Zero API cost: no session is ever sent a message.
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _crypto
from _lib import check, fail, start_daemon, stop_daemon, raw_client, raw_client_tcp

PORT = 7461
BADPROJ = tempfile.mkdtemp(prefix='cc-pairing-transport-')

stop_daemon()
time.sleep(1)
start_daemon('/tmp/pairing_transport.log', extra_env={
    'CC_CLIENT_TCP_PORT': str(PORT), 'CC_CLIENT_TCP_HOST': '127.0.0.1',
})
time.sleep(1)

print("=== A: begin_pair over the NETWORK listener is refused ===")
tcp = raw_client_tcp('127.0.0.1', PORT)
tcp.write(json.dumps({"type": "begin_pair"}) + "\n")
tcp.flush()
resp = json.loads(tcp.readline())
print(f"  begin_pair over TCP -> {resp.get('type')}")
check(resp.get('type') == 'pair_failed', f"A: refused (got {resp.get('type')})")
check('qr' not in resp and 'secret' not in json.dumps(resp),
      "A: and no pairing secret is disclosed to the network peer")
with open('/tmp/pairing_transport.log') as lf:
    check('local-only' in lf.read(), "A: the daemon logged why it refused")

print("\n=== B: begin_pair over the LOCAL socket still works ===")
local = raw_client()
local.write(json.dumps({"type": "begin_pair"}) + "\n")
local.flush()
qr_resp = json.loads(local.readline())
check(qr_resp.get('type') == 'pair_qr', f"B: local begin_pair returns a QR (got {qr_resp.get('type')})")
qr = json.loads(qr_resp['qr'])
check(bool(qr.get('s')), "B: the QR carries the one-time secret, for display on this machine")

print("\n=== C: that secret completes pairing over TCP (the real phone flow) ===")
# The phone never asked the daemon for the secret, it read it off the screen. Modelled here by
# carrying the locally-obtained secret to a TCP connection.
priv, pub = _crypto.generate_identity()
pub_b64 = _crypto.export_public_der_b64(pub)
proof = _crypto.pairing_proof(qr['s'], pub_b64, qr['pk'])
tcp2 = raw_client_tcp('127.0.0.1', PORT)
tcp2.write(json.dumps({"type": "complete_pair", "devicePublicKey": pub_b64,
                       "deviceName": "phone-over-tailnet", "proof": proof}) + "\n")
tcp2.flush()
paired = json.loads(tcp2.readline())
check(paired.get('type') == 'paired',
      f"C: a device holding the out-of-band secret still pairs over the network (got {paired.get('type')})")
device_id = paired['deviceId']

print("\n=== D: and it can drive sealed commands over TCP ===")
tcp2.write(json.dumps({"type": "hello", "deviceId": device_id}) + "\n")
tcp2.flush()
salt_resp = json.loads(tcp2.readline())
check(salt_resp.get('type') == 'session_salt', "D: hello succeeds over the network listener")
import base64
key = _crypto.derive_session_key(priv, _crypto.import_public_der_b64(qr['pk']),
                                 base64.b64decode(salt_resp['salt']))
got = []


def rd():
    for line in tcp2:
        try:
            got.append(_crypto.open_frame(key, json.loads(line)).get('type'))
        except Exception:
            continue


threading.Thread(target=rd, daemon=True).start()
time.sleep(1)
tcp2.write(json.dumps(_crypto.seal(key, 1, {"type": "spawn", "cwd": BADPROJ, "label": "over-tcp"})) + "\n")
tcp2.flush()
time.sleep(2)
print(f"  frames received over TCP: {got}")
check(any(t in ('job_update', 'error') for t in got),
      "D: an already-trusted device still works fully over the network")

stop_daemon()
print("\nPASS")
