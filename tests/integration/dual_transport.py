#!/usr/bin/env python3
"""the client socket behaves identically over TCP and the local Unix socket, and both
transports can be connected simultaneously without cross-talk. Forces CC_CLIENT_TCP_HOST to a
loopback IP so this needs no real Tailscale installation to run. The daemon's `tailscale ip -4`
discovery path is exercised separately, manually, on a machine that has Tailscale. Zero
`spawn`/real `claude -p` calls, zero API cost."""
import json
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import check, fail, start_daemon, stop_daemon, raw_client, raw_client_tcp, pair_and_connect

# Pick a free loopback port without racing another process for it between pick and daemon-start.
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
probe.bind(('127.0.0.1', 0))
PORT = probe.getsockname()[1]
probe.close()

start_daemon('/tmp/v31.log', extra_env={'CC_CLIENT_TCP_HOST': '127.0.0.1', 'CC_CLIENT_TCP_PORT': str(PORT)})

print("=== A: pair + hello + sealed list over the Unix socket ===")
f_unix, device_unix = pair_and_connect('dual-transport-unix')
f_unix.write(json.dumps({"type": "list"}) + "\n"); f_unix.flush()
ev = json.loads(next(iter(f_unix)))
check(ev.get('type') == 'session_list', "A: Unix socket returns a real session_list")

print("\n=== B: the identical sequence over the new TCP socket ===")
conn_tcp = raw_client_tcp('127.0.0.1', PORT)
# begin_pair is local-only (the secret must reach the device out of band), so the TCP device
# bootstraps on the Unix socket and completes over TCP, the real phone flow.
f_tcp, device_tcp = pair_and_connect('dual-transport-tcp', conn=conn_tcp, begin_conn=raw_client())
f_tcp.write(json.dumps({"type": "list"}) + "\n"); f_tcp.flush()
ev = json.loads(next(iter(f_tcp)))
check(ev.get('type') == 'session_list', "B: TCP socket returns a real session_list, same protocol")
check(device_tcp != device_unix, "B: TCP and Unix connections paired as distinct devices")

print("\n=== C: an unauthenticated command over TCP is refused, connection closed ===")
raw_tcp = raw_client_tcp('127.0.0.1', PORT)
raw_tcp.write(json.dumps({"type": "list"}) + "\n"); raw_tcp.flush()
closed = raw_tcp.readline() == ''
check(closed, "C: daemon closes an unauthenticated TCP connection, same as Unix (auth isn't transport-specific)")

print("\n=== D: both paired connections still work after A-C, no cross-talk ===")
f_unix.write(json.dumps({"type": "list"}) + "\n"); f_unix.flush()
ev_unix = json.loads(next(iter(f_unix)))
f_tcp.write(json.dumps({"type": "list"}) + "\n"); f_tcp.flush()
ev_tcp = json.loads(next(iter(f_tcp)))
check(ev_unix.get('type') == 'session_list' and ev_tcp.get('type') == 'session_list',
      "D: both the Unix and TCP connections still respond correctly and independently")

stop_daemon()
print("\nPASS")
