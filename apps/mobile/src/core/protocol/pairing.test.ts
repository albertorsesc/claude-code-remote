// The mobile pairing flow, verified against the daemon's own crypto (node:crypto, test-only, standing
// in for the daemon). It proves: a scanned code decodes through the SHARED format validator; the
// complete_pair proof is byte-compatible with what the daemon verifies; and the record persisted after
// pairing is by itself enough to reconstruct a session that the daemon can talk to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  generateIdentity, exportPublic, importPublic,
  deriveSessionKey as deriveDaemonKey, open as openDaemon, pairingProof as pairingProofDaemon,
} from '@claude-code-remote/protocol/node';
import { decodePairCode, startPairing, deviceRecordFromPaired, sessionCryptoFromRecord } from './pairing.ts';

/** A code exactly as the daemon/CLI mints it: base64url of the QR JSON. */
const mintCode = (payload: object) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

test('decodePairCode round-trips a base64url code and tolerates surrounding whitespace', () => {
  const payload = { v: 1, addr: 'tcp://100.101.102.103:7777', pk: 'DAEMON_SPKI_B64', s: 'one-time-secret' };
  const code = mintCode(payload);
  assert.deepEqual(decodePairCode(code), payload);
  assert.deepEqual(decodePairCode(`  ${code}\n`), payload, 'a pasted code with a trailing newline still decodes');
});

test('decodePairCode rejects garbage and a payload missing required fields', () => {
  assert.throws(() => decodePairCode('not-a-real-code$$$'), /pairing code/i);
  assert.throws(() => decodePairCode(mintCode({ v: 1, addr: 'tcp://x:1', pk: 'p' })), /pk\/s\/addr|missing/i);
});

test('startPairing builds a complete_pair whose proof the daemon accepts', () => {
  const daemon = generateIdentity();
  const payload = { v: 1, addr: 'tcp://127.0.0.1:7443', pk: exportPublic(daemon.publicKey), s: 'sekret' };
  const attempt = startPairing(payload, 'my-phone');

  assert.equal(attempt.completePair.type, 'complete_pair');
  assert.equal(attempt.completePair.deviceName, 'my-phone');
  assert.equal(attempt.target, '127.0.0.1:7443');
  const daemonProof = pairingProofDaemon(payload.s, attempt.completePair.devicePublicKey, payload.pk);
  assert.equal(attempt.completePair.proof, daemonProof, 'the proof is byte-identical to the daemon computation');
});

test('a non-TCP daemon address yields a null target (no reachable listener)', () => {
  const payload = { v: 1, addr: 'unix:///tmp/cc-client.sock', pk: 'x', s: 'y' };
  assert.equal(startPairing(payload, 'phone').target, null);
});

test('the persisted record alone reconstructs a session the daemon can open', () => {
  const daemon = generateIdentity();
  const payload = { v: 1, addr: 'tcp://127.0.0.1:7443', pk: exportPublic(daemon.publicKey), s: 'sekret' };
  const attempt = startPairing(payload, 'phone');
  const record = deviceRecordFromPaired('dev-42', attempt, payload);

  assert.equal(record.deviceId, 'dev-42');
  assert.equal(record.daemonPublicKey, payload.pk, 'daemon key comes from the authenticated payload, not the wire');
  assert.equal(record.devicePublicKey, attempt.completePair.devicePublicKey);

  // The record must be self-sufficient: reconstruct the crypto and prove a sealed command opens.
  const crypto = sessionCryptoFromRecord(record);
  const salt = randomBytes(32);
  const key = crypto.deriveKey(salt.toString('base64'));
  const command = { type: 'interrupt', sessionId: 's1' };
  const frame = crypto.seal(key, 1, command, 'c2d');

  const daemonKey = deriveDaemonKey(daemon.privateKey, importPublic(attempt.completePair.devicePublicKey), salt);
  assert.deepEqual(openDaemon(daemonKey, frame, 'c2d'), command, 'the daemon opened a command from the reconstructed session');
});
