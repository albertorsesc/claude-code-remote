// A corrupt or unreadable store must THROW, not silently regenerate
// (a bare catch here used to rotate the daemon identity on every restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingProof } from '@claude-code-remote/protocol/node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Statically imported, and the store path is passed in. This used to be a dynamic import after
// setting CC_STORE, because pairing.ts read the path at module-load time, but `await import(...)`
// types as `any`, which silently opted this entire file out of type checking. That was not
// theoretical: a change to completePairing's return type left tsc reporting clean while two
// assertions here were actually broken.
import { Identity } from '../src/infrastructure/pairing.ts';

const STORE = path.join(os.tmpdir(), `cc-identity-test-${randomUUID()}.json`);

test('identity is stable across reload', () => {
  const a = Identity.load(STORE);
  const b = Identity.load(STORE);
  assert.equal(a.publicKeyB64, b.publicKeyB64);
});

test('paired devices survive reload', () => {
  const a = Identity.load(STORE);
  const pair = a.beginPairing('tcp://127.0.0.1:9999');
  const qr = JSON.parse(pair.qr);
  const devicePk = 'ZmFrZS1kZXZpY2Uta2V5LWJhc2U2NA==';
  const proof = pairingProof(qr.s, devicePk, a.publicKeyB64);
  const registered = a.completePairing(devicePk, 'iPhone', proof);
  // assert.ok() alone would pass on a failure object too, since both variants are truthy.
  assert.equal(registered.ok, true, 'pairing succeeded');

  const reloaded = Identity.load(STORE);
  assert.equal(reloaded.list().length, 1);
});

test('corrupt store throws instead of silently regenerating', () => {
  fs.writeFileSync(STORE, '{ this is not json');
  assert.throws(() => Identity.load(STORE), /could not be read/);
});

test('unreadable store (EACCES) throws instead of silently regenerating', () => {
  fs.writeFileSync(STORE, '{}');
  fs.chmodSync(STORE, 0o000);
  try {
    assert.throws(() => Identity.load(STORE), /could not be read/);
  } finally {
    fs.chmodSync(STORE, 0o600);
  }
});
