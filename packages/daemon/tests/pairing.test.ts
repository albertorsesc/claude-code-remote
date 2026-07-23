// wrong secret rejected     expired rejected      secret is one-time
// tampered pubkey in proof rejected (MITM)            revoke works
// completing pairing with none in progress is rejected
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingProof } from '@claudecode/protocol/node';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Static import + injected store path: a dynamic import types as `any` and would opt this whole
// file out of type checking (see identity.test.ts).
import { Identity } from '../src/infrastructure/pairing.ts';

const STORE = path.join(os.tmpdir(), `cc-pairing-test-${randomUUID()}.json`);

const DEV = 'ZGV2aWNlLXB1YmxpYy1rZXktYmFzZTY0LXh4eA==';
const EVIL = 'ZXZpbC1wdWJsaWMta2V5LWJhc2U2NC15eXl5eXk=';

test('wrong pairing secret is rejected', () => {
  const id = Identity.load(STORE);
  id.beginPairing('tcp://x');
  const bad = pairingProof('not-the-secret', DEV, id.publicKeyB64);
  assert.deepEqual(id.completePairing(DEV, 'attacker', bad), { ok: false, reason: 'bad_proof' });
});

test('pairing secret is one-time (replay of a valid proof is rejected)', () => {
  const id = Identity.load(STORE);
  const p = JSON.parse(id.beginPairing('tcp://x').qr);
  const proof = pairingProof(p.s, DEV, id.publicKeyB64);
  const first = id.completePairing(DEV, 'iPhone', proof);
  assert.equal(first.ok, true, 'the first, legitimate attempt succeeds');
  // The secret is burned on use, so the replay finds no pending pairing at all.
  const second = id.completePairing(DEV, 'replay', proof);
  assert.deepEqual(second, { ok: false, reason: 'no_pending_pairing' });
});

test('substituted device pubkey with a replayed victim proof is rejected (MITM)', () => {
  const id = Identity.load(STORE);
  const p = JSON.parse(id.beginPairing('tcp://x').qr);
  const victimProof = pairingProof(p.s, DEV, id.publicKeyB64);
  assert.deepEqual(id.completePairing(EVIL, 'mitm', victimProof), { ok: false, reason: 'bad_proof' });
});

test('expired pairing is rejected', () => {
  const id = Identity.load(STORE);
  const p = JSON.parse(id.beginPairing('tcp://x').qr);
  (id as any).pendingPairing.expiresAt = Date.now() - 1;
  const proof = pairingProof(p.s, DEV, id.publicKeyB64);
  assert.deepEqual(id.completePairing(DEV, 'late', proof), { ok: false, reason: 'expired' });
});

test('revoke removes the device and persists across reload', () => {
  const id = Identity.load(STORE);
  const before = id.list().length;
  const target = id.list()[0];
  assert.ok(target, 'expected at least one paired device from an earlier test');
  assert.equal(id.revoke(target.deviceId), true);
  assert.equal(id.list().length, before - 1);

  const reloaded = Identity.load(STORE);
  assert.equal(reloaded.list().length, before - 1);
});

test('completing pairing with none in progress is rejected', () => {
  const id = Identity.load(STORE);
  const proof = pairingProof('anything', DEV, id.publicKeyB64);
  assert.deepEqual(id.completePairing(DEV, 'nopairing', proof), { ok: false, reason: 'no_pending_pairing' });
});
