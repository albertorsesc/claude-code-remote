// The out-of-band pairing code: a compact, copy-pasteable encoding of the daemon's QR payload
// (daemon public key + one-time secret + address). It is carried BY HAND to a second machine so it
// can complete pairing over the network without the daemon ever disclosing the secret over the wire
// (that disclosure is the self-service hole this closed). These are the pure pieces of that
// flow, encode/decode and address parsing, isolated from cc.ts's socket I/O so they are testable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePairCode, decodePairCode, tcpTargetFromAddr } from '../src/pairing.ts';

const QR = JSON.stringify({ v: 1, addr: 'tcp://100.101.102.103:7777', pk: 'DAEMON_PUB_B64', s: 'one-time-secret' });

test('encode → decode round-trips the QR payload losslessly', () => {
  const code = encodePairCode(QR);
  const payload = decodePairCode(code);
  assert.equal(payload.pk, 'DAEMON_PUB_B64');
  assert.equal(payload.s, 'one-time-secret');
  assert.equal(payload.addr, 'tcp://100.101.102.103:7777');
  assert.equal(payload.v, 1);
});

test('the encoded code is a single shell-safe token (no whitespace, no quoting hazards)', () => {
  const code = encodePairCode(QR);
  assert.doesNotMatch(code, /\s/, 'no whitespace, so it survives copy-paste and shell word-splitting');
  assert.doesNotMatch(code, /[^A-Za-z0-9\-_=]/, 'base64url alphabet only');
});

test('decode tolerates surrounding whitespace (a pasted code with a trailing newline)', () => {
  const code = encodePairCode(QR);
  const payload = decodePairCode(`  ${code}\n`);
  assert.equal(payload.s, 'one-time-secret');
});

test('decode rejects garbage with a clear error, never a partial payload', () => {
  assert.throws(() => decodePairCode('not a real code $$$'), /pairing code/i);
});

test('decode rejects a well-formed base64 that is missing required fields', () => {
  const missingSecret = Buffer.from(JSON.stringify({ v: 1, addr: 'tcp://x:1', pk: 'p' }), 'utf8').toString('base64url');
  assert.throws(() => decodePairCode(missingSecret), /pk\/s\/addr|missing/i);
});

test('tcpTargetFromAddr extracts host:port from a tcp:// address', () => {
  assert.equal(tcpTargetFromAddr('tcp://100.101.102.103:7777'), '100.101.102.103:7777');
});

test('tcpTargetFromAddr returns null for a non-TCP address (daemon not reachable off-machine)', () => {
  assert.equal(tcpTargetFromAddr('unix:///tmp/cc-client.sock'), null,
    'a unix:// address means the daemon has no TCP listener, so a remote device cannot reach it');
});
