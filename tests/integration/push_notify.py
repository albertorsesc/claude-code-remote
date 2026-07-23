#!/usr/bin/env python3
"""Push-on-approval, end to end against the live daemon, ZERO API cost.

The whole path is exercised except Expo itself: a paired device registers a push token over the
sealed channel (register_push), then a synthetic approval_request injected into the hook socket makes
an approval go pending (no real `claude -p`, the bridge opens the approval even for an unknown
session). The daemon must then POST a wake ping to the configured push endpoint, which here is a local
mock standing in for exp.host (CC_PUSH_ENDPOINT override).

Two things are asserted, and the second is the point of the whole design:
  A. the registered token reaches the endpoint (the path works);
  B. the payload carries NO session/tool/command detail, only a generic ping. The sensitive content
     of the approval (a destructive Bash command here) must never transit the third-party relay; the
     phone pulls it over the E2E channel instead.
"""
import http.server
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import check, fail, start_daemon, stop_daemon, pair_and_connect, wait_for

HOOK_SOCK = '/tmp/cc-daemon.sock'
TOKEN = 'ExponentPushToken[push-notify-test]'

# --- a local mock of the Expo push endpoint -------------------------------------------------------
captured = []


class MockPushHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length).decode('utf-8')
        captured.append({'path': self.path, 'content_type': self.headers.get('content-type'), 'body': body})
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data":[{"status":"ok"}]}')

    def log_message(self, *_a):
        pass  # keep the test output clean


mock = http.server.HTTPServer(('127.0.0.1', 0), MockPushHandler)
PORT = mock.server_address[1]
threading.Thread(target=mock.serve_forever, daemon=True).start()

start_daemon('/tmp/push_notify.log', extra_env={
    'CC_PUSH_ENABLED': '1',
    'CC_PUSH_ENDPOINT': f'http://127.0.0.1:{PORT}/push',
})

try:
    print("=== pair a device and register its push token ===")
    chan, _device_id = pair_and_connect('push-notify')
    chan.write(json.dumps({"type": "register_push", "token": TOKEN, "platform": "ios"}))
    chan.flush()
    time.sleep(1.5)  # let the daemon dispatch register_push and persist the registration
    check(len(captured) == 0, "no push is sent merely by registering, only an approval triggers one")

    print("\n=== a tool call goes pending; the daemon must wake the registered device ===")
    hook = socket.socket(socket.AF_UNIX)
    hook.connect(HOOK_SOCK)
    hook.sendall((json.dumps({
        "kind": "approval_request",
        "event": {
            "tool_use_id": "push-notify-tu-1",
            "session_id": "claude-nonexistent", # unknown session; the bridge still opens the approval
            "tool_name": "Bash",
            "tool_input": {"command": "rm -rf ~/secret-work", "description": "delete everything"},
        },
    }) + "\n").encode())

    wait_for(lambda: len(captured) >= 1, timeout=15)
    check(len(captured) >= 1, "the daemon POSTed a wake ping to the push endpoint")

    post = captured[0]
    check(post['path'] == '/push', f"posted to the configured endpoint path (got {post['path']})")
    check(post['content_type'] == 'application/json', "sent as JSON")

    messages = json.loads(post['body'])
    check(isinstance(messages, list) and len(messages) == 1, "one message for the one registered device")
    tokens = messages[0].get('to')
    check(tokens == TOKEN or (isinstance(tokens, list) and TOKEN in tokens),
          f"the wake ping targets the registered token (got {tokens})")

    print("\n=== the payload leaks NO approval detail to the relay ===")
    body = post['body']
    check('rm -rf' not in body, "the destructive command never reaches the third-party push relay")
    check('secret-work' not in body, "no command content in the push payload")
    check('Bash' not in body, "no tool name in the push payload")
    check('push-notify-tu-1' not in body, "no tool_use_id in the push payload")
    check('claude-nonexistent' not in body, "no session id in the push payload")
    check(messages[0].get('data') == {'kind': 'approval'}, "only a generic marker travels to the relay")

    print("\nPASS")
finally:
    mock.shutdown()
    stop_daemon()
