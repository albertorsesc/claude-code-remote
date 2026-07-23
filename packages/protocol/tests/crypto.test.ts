//  two independent parties derive the same key via X25519 and exchange messages
//  tampered ciphertext is rejected
//  tampered seq (AAD) is rejected  -> replay/reorder protection
//  a third party's key cannot decrypt
//  nonces are unique across many seals
//  no plaintext leaks into the sealed frame (FIELD_POLICY)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateIdentity, deriveSessionKey, seal, open, FIELD_POLICY } from '@claudecode/protocol/node';

function pairedKeys() {
  const daemon = generateIdentity();
  const phone = generateIdentity();
  const eve = generateIdentity();
  const salt = randomBytes(32);
  const kD = deriveSessionKey(daemon.privateKey, phone.publicKey, salt);
  const kP = deriveSessionKey(phone.privateKey, daemon.publicKey, salt);
  const kE = deriveSessionKey(eve.privateKey, daemon.publicKey, salt);
  return { kD, kP, kE };
}

test('X25519 ECDH yields an identical session key on both sides', () => {
  const { kD, kP } = pairedKeys();
  assert.ok(kD.equals(kP));
});

test('seal/open roundtrip preserves the payload', () => {
  const { kD, kP } = pairedKeys();
  const secret = { prompt: 'deploy the SUPER_SECRET_TOKEN to prod', apiKeys: ['sk-ant-xxx'] };
  const frame = seal(kD, 1, secret, 'd2c');
  assert.deepEqual(open(kP, frame, 'd2c'), secret);
});

test('tampered ciphertext is rejected', () => {
  const { kD, kP } = pairedKeys();
  const frame = seal(kD, 1, { x: 1 }, 'd2c');
  const b = Buffer.from(frame.c, 'base64');
  b[0] ^= 0xff;
  const bad = { ...frame, c: b.toString('base64') };
  assert.throws(() => open(kP, bad, 'd2c'));
});

test('tampered seq (AAD) is rejected, blocks replay/reorder', () => {
  const { kD, kP } = pairedKeys();
  const frame = seal(kD, 1, { x: 1 }, 'd2c');
  const bad = { ...frame, seq: 999 };
  assert.throws(() => open(kP, bad, 'd2c'));
});

test('a frame sealed for one direction cannot be opened as the other', () => {
  // The reflection attack: an on-path relay bounces a daemon→client frame back at the daemon.
  // With direction bound into the AAD, the daemon's open() (which expects 'c2d') rejects it.
  const { kD, kP } = pairedKeys();
  const daemonToClient = seal(kD, 4211, { type: 'session_update' }, 'd2c');
  // Opening with the correct direction works...
  assert.deepEqual(open(kP, daemonToClient, 'd2c'), { type: 'session_update' });
  // ...but reflecting it back into the daemon's inbound path (which opens as 'c2d') must fail.
  assert.throws(() => open(kD, daemonToClient, 'c2d'),
    'a reflected daemon→client frame must not authenticate as a client→daemon command');
  // Symmetric: a real client→daemon frame must not open as daemon→client either.
  const clientToDaemon = seal(kP, 7, { type: 'list' }, 'c2d');
  assert.throws(() => open(kD, clientToDaemon, 'd2c'));
  assert.deepEqual(open(kD, clientToDaemon, 'c2d'), { type: 'list' });
});

test('a third party cannot decrypt', () => {
  const { kD, kE } = pairedKeys();
  const frame = seal(kD, 1, { x: 1 }, 'd2c');
  assert.throws(() => open(kE, frame, 'd2c'));
});

test('nonces are unique across many seals', () => {
  const { kD } = pairedKeys();
  const N = 20000;
  const seen = new Set<string>();
  for (let i = 0; i < N; i++) seen.add(seal(kD, i, { i }, 'd2c').n);
  assert.equal(seen.size, N);
});

test('no plaintext leaks onto the wire, and wire keys stay inside FIELD_POLICY', () => {
  const { kD } = pairedKeys();
  const payload = { prompt: 'LEAK_CANARY_ABC', toolInput: { command: 'rm -rf /' }, cwd: '/secret/path' };
  const f = seal(kD, 7, payload, 'd2c');
  const wire = JSON.stringify(f);
  const leaks = ['LEAK_CANARY_ABC', 'rm -rf /', '/secret/path'].filter((s) => wire.includes(s));
  assert.deepEqual(leaks, []);

  const wireKeys = Object.keys(f).sort();
  const allowed = [...FIELD_POLICY.metadata].sort();
  const unexpected = wireKeys.filter((k) => !allowed.includes(k as any));
  assert.deepEqual(unexpected, []);
});

test('a sealed ack never exposes its command-count (upTo) on the wire in plaintext', () => {
  // The empirical proof of the sealed-ack decision: the cumulative ack rides inside the encrypted
  // envelope, so a relay can't read a device's command-sent count. A hypothetical plaintext ack
  // (in session_salt) would fail exactly this assertion. upTo is a distinctive canary value.
  const { kD } = pairedKeys();
  const ack = { type: 'ack', upTo: 424242 };
  const f = seal(kD, 9, ack, 'd2c');
  const wire = JSON.stringify(f);
  assert.ok(!wire.includes('424242'), 'the ack count must not appear on the wire in plaintext');
  assert.ok(!wire.includes('ack'), 'not even the event type leaks, the whole envelope is encrypted');

  // And it's genuinely recoverable inside the envelope (sanity: it IS the ack, just encrypted).
  assert.deepEqual(open(kD, f, 'd2c'), ack);

  // 'upTo' is documented in FIELD_POLICY.encrypted, not metadata.
  assert.ok((FIELD_POLICY.encrypted as readonly string[]).includes('upTo'));
  assert.ok(!(FIELD_POLICY.metadata as readonly string[]).includes('upTo'));
});
