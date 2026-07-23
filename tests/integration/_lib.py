"""Shared helpers for integration scripts: real daemon + real headless `claude` sessions.
Ground truth is a filesystem side effect or a typed event over the client socket,
never terminal output scraping (that confound bit us twice already)."""
import atexit
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

import _crypto

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TESTBED = os.path.join(ROOT, 'testbed')
CLIENT_SOCK = '/tmp/cc-client.sock'


def fail(msg):
    print(f"  FAIL: {msg}")
    sys.exit(1)


def check(cond, msg):
    if not cond:
        fail(msg)
    print(f"  OK: {msg}")


# A real headless session's first tool call is gated on live API latency, and the suite spawns many
# sessions back to back, so responses slow down under rate limiting (observed directly: `claude -p`
# emits rate_limit_event during a run). A fixed 90s deadline lost that race intermittently, which
# made the suite report failures that said nothing about the code under test. Waiting longer costs
# nothing on the happy path (the predicate is polled, so a fast session returns immediately) and
# only spends the extra time when something is genuinely wrong.
APPROVAL_WAIT_S = 240
# A session's system/init also waits on the live API (it arrives only after first input).
INIT_WAIT_S = 120


def wait_for(pred, timeout=APPROVAL_WAIT_S, interval=0.3):
    """Poll until pred() is truthy. Returns whether it became true, so callers keep their own
    failure message and diagnostics rather than dying inside the helper."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        time.sleep(interval)
    return pred()



# The daemon's entry point, defined ONCE. The launch command and the pkill pattern MUST stay
# derived from this single constant: they were previously two independent literals, so moving the
# daemon updated the launcher but silently left the kill pattern matching nothing. A kill pattern
# that matches nothing is worse than a crash, orphaned daemons survive cleanup and the next test
# connects to a stale process running old code, which reports green for code that was never run.
DAEMON_ENTRY = 'packages/daemon/src/index.ts'
DAEMON_PKILL_PATTERN = f"pkill -f '{DAEMON_ENTRY}'"
SESSION_PKILL_PATTERN = "pkill -f 'claude -p --input-format'"


def _cleanup_orphans():
    """Kill the daemon and any spawned sessions on EVERY exit path.

    Scripts call stop_daemon() as their last line, but fail() exits before reaching it, so a
    FAILING run used to leak its daemon and its live `claude` sessions. Those orphans then load
    the machine and slow the next run's session startup past its wait window, so one failure
    manufactured the next one, and the suite got flakier the more it failed. Cleanup belongs on
    interpreter shutdown, which covers success, fail(), and uncaught exceptions alike."""
    subprocess.run(DAEMON_PKILL_PATTERN, shell=True)
    subprocess.run(SESSION_PKILL_PATTERN, shell=True)


atexit.register(_cleanup_orphans)


def start_daemon(log_path, self_deny_ms=120000, extra_env=None, store=None):
    """Fresh CC_STORE per call by default: an integration run must not read or pollute the
    real ~/.config/app.claudecode/daemon.json, and must not inherit paired devices left over
    from a previous test run. Pass `store` explicitly to reuse the same identity across a
    stop_daemon()+start_daemon() cycle, simulates "same identity, restarted process" for the
    daemon-restart guard (a new process's in-memory replay state is empty even though the
    on-disk identity is unchanged)."""
    subprocess.run(DAEMON_PKILL_PATTERN, shell=True)
    time.sleep(1)
    store = store or tempfile.mktemp(prefix='cc-daemon-identity-', suffix='.json')
    # Isolate the durable DB the same way CC_STORE isolates identity, and with the same discipline:
    # fresh-and-isolated BY DEFAULT, persisted only by EXPLICIT opt-in. Each start_daemon() gets its
    # own temp DB unless the caller passes CC_DB_PATH, so an integration run never reads or pollutes
    # the real ~/.config/app.claudecode/daemon.db, and a fixed-store test cannot accumulate jobs in a
    # derived DB across runs (which would leak into the resync snapshot now that it reads recent
    # durable jobs). A test that genuinely needs the DB to survive its OWN restart (e.g.
    # orphan_recovery) declares that intent by passing CC_DB_PATH, exactly as it passes store= to
    # keep one identity, the two persistences are independent and both are opt-in.
    env = dict(extra_env or {})
    env.setdefault('CC_DB_PATH', tempfile.mktemp(prefix='cc-daemon-db-', suffix='.db'))
    env_prefix = f"CC_HOOK_SELF_DENY_MS={self_deny_ms} CC_STORE={store}"
    for k, v in env.items():
        env_prefix += f" {k}={v}"
    proc = subprocess.Popen(
        f"{env_prefix} node {DAEMON_ENTRY}",
        shell=True, cwd=ROOT,
        stdout=open(log_path, 'w'), stderr=subprocess.STDOUT,
    )
    time.sleep(3)
    return proc, store


def stop_daemon():
    subprocess.run(DAEMON_PKILL_PATTERN, shell=True)
    subprocess.run(SESSION_PKILL_PATTERN, shell=True)


def raw_client():
    """An unauthenticated raw socket: only valid for begin_pair/complete_pair/hello, or for
    proving the daemon rejects anything else pre-auth. `f._sock` is attached so callers can set a
    read timeout (SealedChannel.drain) or shut down the connection cleanly."""
    s = socket.socket(socket.AF_UNIX)
    s.connect(CLIENT_SOCK)
    f = s.makefile('rw')
    f._sock = s
    return f


def raw_client_tcp(host, port):
    """Same contract as raw_client(), over TCP instead of the local Unix socket."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect((host, port))
    f = s.makefile('rw')
    f._sock = s
    return f


class ClientSeqState:
    """Client→daemon state that persists across a simulated reconnect, mirrors cc.ts's persistent
    out (seq counter), resend buffer (unacked), and maxAcked. Pass one instance to successive
    hello() calls for the same device to model command redelivery across a dropped connection."""

    def __init__(self):
        self.out_seq = 0
        self.unacked = {}     # seq -> plaintext command
        self.max_acked = 0


class SealedChannel:
    """Wraps a raw socket file object so scripts can keep doing
    `f.write(json.dumps(cmd) + "\\n")` and `for line in f: ev = json.loads(line)`
    without knowing the wire format is now SealedFrame JSON, not plaintext.

    Command-redelivery aware: outbound commands consume a persistent seq and are buffered for
    resend (like the real client); inbound `ack` frames are swallowed transparently (apply upTo,
    drop acked commands, never surface them) so existing tests that don't care about acks stay
    green."""

    def __init__(self, raw_file, key: bytes, seq_state=None):
        self._f = raw_file
        self._key = key
        self._state = seq_state if seq_state is not None else ClientSeqState()
        self.last_seq_received = 0  # mirrors a real client's InboundStream.lastSeq

    def write(self, line: str, buffer=True):
        obj = json.loads(line)
        self._state.out_seq += 1
        seq = self._state.out_seq
        if buffer:
            self._state.unacked[seq] = obj
        self._f.write(json.dumps(_crypto.seal(self._key, seq, obj)) + "\n")
        return seq

    def resend_unacked(self):
        """Resend every buffered unacked command at its ORIGINAL seq under this channel's key,
        the daemon dedups by per-device seq, so a resend is never re-executed."""
        for seq in sorted(self._state.unacked):
            self._f.write(json.dumps(_crypto.seal(self._key, seq, self._state.unacked[seq])) + "\n")
        self._f.flush()

    @property
    def max_acked(self):
        return self._state.max_acked

    @property
    def unacked_count(self):
        return len(self._state.unacked)

    def flush(self):
        self._f.flush()

    def _consume(self, frame, ev):
        """Shared frame bookkeeping: track last_seq, apply+swallow acks. Returns True if `ev` is a
        real event to surface, False if it was an ack (swallowed)."""
        if isinstance(frame, dict) and isinstance(frame.get('seq'), int):
            self.last_seq_received = max(self.last_seq_received, frame['seq'])
        if isinstance(ev, dict) and ev.get('type') == 'ack':
            self._state.max_acked = max(self._state.max_acked, ev['upTo'])
            for seq in [s for s in self._state.unacked if s <= ev['upTo']]:
                del self._state.unacked[seq]
            return False
        return True

    def __iter__(self):
        for raw_line in self._f:
            try:
                frame = json.loads(raw_line)
                ev = _crypto.open_frame(self._key, frame)
            except Exception:
                continue  # undecryptable/tampered frame, dropped, not surfaced as data
            if self._consume(frame, ev):
                yield json.dumps(ev) + "\n"

    def start_reader(self, on_event):
        """Spawn a daemon thread that reads this channel until it closes, calling on_event(dict)
        for each real event (acks are applied+swallowed by __iter__). Blocking readline, NO socket
        timeout, a makefile read that times out is left unusable (a real footgun this avoids).
        Stop it with close(), which shuts the socket down first to unblock the readline cleanly."""
        def rd():
            for line in self:
                try:
                    on_event(json.loads(line))
                except Exception:
                    continue
        t = threading.Thread(target=rd, daemon=True)
        t.start()
        return t

    def close(self):
        # shutdown() BEFORE close(): unblocks any reader thread's blocked readline (close() alone
        # would deadlock against a thread holding the buffer's read lock).
        try:
            self._f._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._f.close()


def pair_only(device_name='integration-test', conn=None, begin_conn=None):
    """Just begin_pair/complete_pair, no hello. Returns everything hello() needs:
    (f, device_priv, device_pub_b64, daemon_pub_b64, device_id).

    `begin_conn` is where begin_pair runs, defaulting to `conn`. Pass a LOCAL connection whenever
    `conn` is a network connection: begin_pair is local-only by design, because the one-time secret
    must reach the device OUT OF BAND (displayed on the daemon's machine, read by the phone's
    camera) rather than being handed to whoever asks over the network. Splitting the two calls is
    what models the real phone flow.
    """
    f = conn if conn is not None else raw_client()
    b = begin_conn if begin_conn is not None else f

    device_priv, device_pub = _crypto.generate_identity()
    device_pub_b64 = _crypto.export_public_der_b64(device_pub)

    b.write(json.dumps({"type": "begin_pair"}) + "\n"); b.flush()
    resp = json.loads(b.readline())
    if resp.get('type') != 'pair_qr':
        fail(f"begin_pair: expected pair_qr, got {resp}")
    qr = json.loads(resp['qr'])
    daemon_pub_b64 = qr['pk']

    proof = _crypto.pairing_proof(qr['s'], device_pub_b64, daemon_pub_b64)
    f.write(json.dumps({
        "type": "complete_pair", "devicePublicKey": device_pub_b64,
        "deviceName": device_name, "proof": proof,
    }) + "\n"); f.flush()
    resp = json.loads(f.readline())
    if resp.get('type') != 'paired':
        fail(f"complete_pair: expected paired, got {resp}")
    device_id = resp['deviceId']
    check(resp['daemonPublicKey'] == daemon_pub_b64, "daemon public key consistent between pair_qr and paired")

    return f, device_priv, device_pub_b64, daemon_pub_b64, device_id


def hello(f, device_priv, daemon_pub_b64, device_id, last_seq=None, seq_state=None):
    """Just the hello step. Returns (SealedChannel, raw session_salt response dict) so a
    test can assert on `resumed`/`replayedCount` directly. Pass `seq_state` (a ClientSeqState)
    to persist client→daemon seq + unacked buffer across a simulated reconnect (command
    redelivery); omit it for a fresh, independent connection.

    GOTCHA (hit 4 times this session before this note existed): the daemon sends an
    UNSOLICITED full resync (session_list, then any pending approvals/jobs) immediately
    after session_salt, whether resumed or not. That frame sits buffered ahead of whatever
    your test does next. If your very next read/assertion cares about a SPECIFIC event type
    or content, drain the resync first:
        channel, _ = hello(f, ...)
        json.loads(next(iter(channel)))  # drain the resync before anything content-sensitive
    Skip the drain only if your test genuinely doesn't care what the first frame is (e.g. it
    loops `for line in f: ... break` looking for a specific type, which works either way).
    Note: a post-hello `ack` frame (present when this device has sent commands before) is
    swallowed transparently by SealedChannel, so it never appears in the drain."""
    msg = {"type": "hello", "deviceId": device_id}
    if last_seq is not None:
        msg["lastSeq"] = last_seq
    f.write(json.dumps(msg) + "\n"); f.flush()
    resp = json.loads(f.readline())
    if resp.get('type') != 'session_salt':
        fail(f"hello: expected session_salt, got {resp}")
    salt = __import__('base64').b64decode(resp['salt'])

    daemon_pub = _crypto.import_public_der_b64(daemon_pub_b64)
    key = _crypto.derive_session_key(device_priv, daemon_pub, salt)

    return SealedChannel(f, key, seq_state), resp


def pair_and_connect(device_name='integration-test', conn=None, begin_conn=None):
    """Full pairing + hello handshake on one connection, matching the daemon's real
    protocol. Returns a SealedChannel a script can use exactly like the old raw socket.
    Pass `conn` (e.g. from raw_client_tcp) to pair over a transport other than the
    default local Unix socket, together with `begin_conn` for the local begin_pair step."""
    f, device_priv, device_pub_b64, daemon_pub_b64, device_id = pair_only(device_name, conn, begin_conn)
    channel, _salt_resp = hello(f, device_priv, daemon_pub_b64, device_id)
    return channel, device_id
