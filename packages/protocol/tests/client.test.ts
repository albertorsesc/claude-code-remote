// The reliable-delivery client state machine (client.ts). Driven with a FAKE SessionCrypto so the
// reliability invariants are tested in isolation, no sockets, no clocks, no real crypto. The fake
// still enforces direction binding (open rejects a frame whose sealed direction differs from the
// requested one), so the direction-reflection defense is exercised for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReliableClient, ResendOverflowError, type SessionCrypto } from '../src/client.ts';
import type { SealedFrame, Direction } from '../src/frame.ts';

// Fake crypto: `c` carries the plaintext JSON, `t` carries the direction it was sealed for. open()
// throws when asked for the wrong direction, mirroring the AEAD direction binding.
function fakeCrypto(): SessionCrypto {
  return {
    deriveKey: (saltB64) => ({ salt: saltB64 }),
    seal: (_key, seq, plaintext, direction) => ({ n: 'n', c: JSON.stringify(plaintext), t: direction, seq }),
    open: (_key, frame, direction) => {
      if (frame.t !== direction) throw new Error('direction mismatch');
      return JSON.parse(frame.c);
    },
  };
}

/** Build a frame as the DAEMON would seal it (d2c). Matches fakeCrypto.seal's shape. */
function d2c(seq: number, event: unknown): SealedFrame {
  return { n: 'n', c: JSON.stringify(event), t: 'd2c' as Direction, seq };
}

interface Recorder {
  events: [unknown, number][];
  acks: number[];
  ready: { resumed: boolean; replayedCount: number }[];
  rejected: number;
  authErrors: number;
}

function makeClient(overrides: Partial<{ startSeq: number }> = {}) {
  const rec: Recorder = { events: [], acks: [], ready: [], rejected: 0, authErrors: 0 };
  let s = overrides.startSeq ?? 0;
  const c = new ReliableClient({
    deviceId: 'dev-1',
    crypto: fakeCrypto(),
    nextSeq: () => ++s,
    onEvent: (event, seq) => rec.events.push([event, seq]),
    onAck: (upTo) => rec.acks.push(upTo),
    onReady: (info) => rec.ready.push(info),
    onHelloRejected: () => rec.rejected++,
    onAuthError: () => rec.authErrors++,
  });
  return { c, rec };
}

/** Run a full handshake and return the frames the client wanted to write during it. */
function handshake(c: ReliableClient, opts: { resumed?: boolean; replayedCount?: number } = {}) {
  c.onOpen();
  const helloFrames = c.drain();
  c.onMessage({ type: 'session_salt', salt: 'SALT', resumed: opts.resumed ?? true, replayedCount: opts.replayedCount ?? 0 });
  return { hello: helloFrames, afterSalt: c.drain() };
}

test('onOpen sends a bare hello on the first connection (no resume checkpoint yet)', () => {
  const { c } = makeClient();
  c.onOpen();
  assert.deepEqual(c.drain(), [{ type: 'hello', deviceId: 'dev-1' }]);
});

test('after accepting a frame, the reconnect hello resumes from that inbound checkpoint', () => {
  const { c } = makeClient();
  handshake(c);
  c.onMessage(d2c(5, { type: 'session_update', session: {} }));
  c.onClose();
  c.onOpen();
  assert.deepEqual(c.drain(), [{ type: 'hello', deviceId: 'dev-1', lastSeq: 5 }]);
});

test('session_salt derives the key, flips ready, and fires onReady with the resume info', () => {
  const { c, rec } = makeClient();
  assert.equal(c.ready, false);
  handshake(c, { resumed: true, replayedCount: 3 });
  assert.equal(c.ready, true);
  assert.deepEqual(rec.ready, [{ resumed: true, replayedCount: 3 }]);
});

test('an authenticated non-ack frame is delivered to onEvent with its seq', () => {
  const { c, rec } = makeClient();
  handshake(c);
  const ev = { type: 'approval_pending', approval: { toolUseId: 'x' } };
  c.onMessage(d2c(1, ev));
  assert.deepEqual(rec.events, [[ev, 1]]);
});

test('a duplicate seq is dropped (delivered exactly once)', () => {
  const { c, rec } = makeClient();
  handshake(c);
  const ev = { type: 'session_update', session: {} };
  c.onMessage(d2c(7, ev));
  c.onMessage(d2c(7, ev)); // replay
  assert.equal(rec.events.length, 1);
});

test('a frame reflected in the wrong direction fails to open and is dropped, not rendered', () => {
  const { c, rec } = makeClient();
  handshake(c);
  // A c2d-sealed frame (as if a relay reflected a client→daemon frame back at us) opened as d2c.
  const reflected: SealedFrame = { n: 'n', c: JSON.stringify({ type: 'ack', upTo: 99 }), t: 'c2d', seq: 1 };
  c.onMessage(reflected);
  assert.equal(rec.authErrors, 1);
  assert.equal(rec.events.length, 0);
  assert.equal(rec.acks.length, 0, 'a reflected frame must not advance ack accounting');
});

test('dedup happens AFTER auth: a bad frame does not burn its seq for the genuine one', () => {
  const { c, rec } = makeClient();
  handshake(c);
  // An unauthenticatable frame arrives at seq 4 (wrong direction). If we deduped before opening, seq 4
  // would be consumed and the real event at seq 4 would look like a duplicate and vanish.
  c.onMessage({ n: 'n', c: JSON.stringify({ type: 'session_update', session: {} }), t: 'c2d', seq: 4 });
  assert.equal(rec.authErrors, 1);
  // The genuine frame at the same seq still delivers.
  const real = { type: 'session_update', session: { id: 'real' } };
  c.onMessage(d2c(4, real));
  assert.deepEqual(rec.events, [[real, 4]]);
});

test('send(reliable) assigns the next seq, seals immediately when ready, and buffers for resend', () => {
  const { c } = makeClient();
  handshake(c);
  const seq = c.send({ type: 'decide', toolUseId: 't', decision: 'allow', by: 'me' }, { reliable: true });
  assert.equal(seq, 1);
  const out = c.drain();
  assert.equal(out.length, 1);
  assert.equal((out[0] as SealedFrame).seq, 1);
  assert.equal((out[0] as SealedFrame).t, 'c2d', 'client commands are sealed c2d');
});

test('an unacked reliable command is resent at its ORIGINAL seq on reconnect', () => {
  const { c } = makeClient();
  handshake(c);
  c.send({ type: 'spawn', cwd: '/x' }, { reliable: true }); // seq 1
  c.drain();
  c.onClose();
  const { afterSalt } = handshake(c, { resumed: true }); // key survives; inb kept
  assert.equal(afterSalt.length, 1, 'the one unacked command is resent');
  assert.equal((afterSalt[0] as SealedFrame).seq, 1, 'resent at its original seq so the daemon dedups it');
});

test('an ack advances lastAcked, clears the command from resend, and fires onAck', () => {
  const { c, rec } = makeClient();
  handshake(c);
  c.send({ type: 'interrupt', sessionId: 's' }, { reliable: true }); // seq 1
  c.drain();
  c.onMessage(d2c(1, { type: 'ack', upTo: 1 }));
  assert.deepEqual(rec.acks, [1]);
  assert.equal(c.lastAcked, 1);
  // Now a reconnect must NOT resend it, it was acked.
  c.onClose();
  const { afterSalt } = handshake(c, { resumed: true });
  assert.equal(afterSalt.length, 0, 'an acked command is not resent');
});

test('a full resync (resumed:false) resets the inbound checkpoint so the REUSED low seqs are accepted', () => {
  const { c, rec } = makeClient();
  handshake(c);
  // The old sequence space saw seqs 1 and 2.
  c.onMessage(d2c(1, { type: 'session_update', session: {} }));
  c.onMessage(d2c(2, { type: 'session_update', session: {} }));
  assert.equal(rec.events.length, 2);
  c.onClose();
  // Daemon restarted: its per-device seq restarts at 1, so the resync REUSES seq 1, which the old
  // checkpoint has already seen. Without resetting inb, accept(1) would reject it (1 <= highest AND
  // seen), silently swallowing the resync while the reconnect still reported success. With the reset,
  // seq 1 is fresh again and delivered.
  handshake(c, { resumed: false });
  c.onMessage(d2c(1, { type: 'session_list', sessions: [] }));
  assert.equal(rec.events.length, 3, 'the reused seq 1 must be delivered, not dropped as a stale duplicate');
});

test('resends are ordered before a command the host issues from its onReady handler', () => {
  const rec: SealedFrame[] = [];
  let s = 0;
  const c = new ReliableClient({
    deviceId: 'd',
    crypto: fakeCrypto(),
    nextSeq: () => ++s,
    onEvent: () => {},
    // On every ready, issue a fresh read, exactly the CLI's history-reissue pattern.
    onReady: () => { c.send({ type: 'history' }, { reliable: false }); },
  });
  handshake(c); // seq 1 = the read issued in onReady
  c.send({ type: 'spawn', cwd: '/x' }, { reliable: true }); // seq 2, buffered
  c.drain();
  c.onClose();
  const { afterSalt } = handshake(c);
  // The resent write (seq 2) must precede the freshly-reissued read (seq 3) in write order.
  assert.deepEqual(afterSalt.map((f) => (f as SealedFrame).seq), [2, 3]);
});

test('hello_failed fires onHelloRejected', () => {
  const { c, rec } = makeClient();
  c.onOpen();
  c.drain();
  c.onMessage({ type: 'hello_failed' });
  assert.equal(rec.rejected, 1);
});

test('a reliable command sent while disconnected is buffered and goes out on the next ready', () => {
  const { c } = makeClient();
  // Never connected: no key yet.
  c.send({ type: 'decide', toolUseId: 't', decision: 'deny', by: 'me' }, { reliable: true }); // seq 1
  assert.deepEqual(c.drain(), [], 'nothing to write while disconnected');
  const { afterSalt } = handshake(c);
  assert.equal(afterSalt.length, 1, 'the buffered command is sent once the key is live');
  assert.equal((afterSalt[0] as SealedFrame).seq, 1);
});

test('send throws ResendOverflowError at capacity rather than silently dropping a command', () => {
  const { c } = makeClient();
  handshake(c);
  for (let i = 0; i < 256; i++) c.send({ type: 'send', sessionId: 's', text: `${i}` }, { reliable: true });
  assert.throws(() => c.send({ type: 'send', sessionId: 's', text: 'overflow' }, { reliable: true }), ResendOverflowError);
});
