// Proves the RN crypto module is BYTE-COMPATIBLE with the daemon (`@claudecode/protocol/node`),
// using FIXED VECTORS generated once from the node implementation. Because the vectors are fixed
// strings, this test needs no node:crypto and runs
// in the React Native environment (and in Node), the whole point of the crypto seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
  deriveSessionKey, seal, open, pairingProof,
  generateKeyPair, spkiPublicKeyB64, rawPublicKeyFromB64, toBase64, fromBase64,
} from './frameCrypto.ts';

// Vectors from the DAEMON's crypto-node (fixed keys, salt, frame, proof).
const V = {
  devicePrivHex: '0101010101010101010101010101010101010101010101010101010101010101',
  daemonPubHex: 'ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59',
  saltB64: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
  expectedKeyHex: '221e44867e56c2dcd4499d77f3f176454d495ef2bf8bd5b7dc5140860f10639f',
  d2cFrame: {
    n: '5i+jHMflIPTS6Z7l',
    c: 'uw6eAmGxU6wHGgY6A9Vt3W9lSvUzpw+kCLRokbpXWoAVsqg9Mc7/mECyuo2ZePWs5GqAtz6pYVbA9nYgwwg2H5RDO5HLDgT3cd+EiNsW87c=',
    t: 'rBnRZy65e1rguJW6tCRiuA==',
    seq: 4211,
  },
  d2cPlaintext: { type: 'session_update', session: { id: 's1', label: 'demo', state: 'working' } },
  secret: 'one-time-secret-abc',
  devicePubB64: 'MCowBQYDK2VuAyEApOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=',
  daemonPubB64: 'MCowBQYDK2VuAyEAzo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=',
  expectedProof: 'gmvJLXaKaiCOfnKHFAoIAMuhkkPKd228RfqeD8FJ2j0=',
};

test('deriveSessionKey matches the daemon byte-for-byte', () => {
  const key = deriveSessionKey(hexToBytes(V.devicePrivHex), hexToBytes(V.daemonPubHex), fromBase64(V.saltB64));
  assert.equal(bytesToHex(key), V.expectedKeyHex);
});

test('open() decrypts a frame the daemon sealed (d2c)', () => {
  const key = deriveSessionKey(hexToBytes(V.devicePrivHex), hexToBytes(V.daemonPubHex), fromBase64(V.saltB64));
  assert.deepEqual(open(key, V.d2cFrame, 'd2c'), V.d2cPlaintext);
});

test('a daemon d2c frame reflected as c2d fails to open (direction binding)', () => {
  const key = deriveSessionKey(hexToBytes(V.devicePrivHex), hexToBytes(V.daemonPubHex), fromBase64(V.saltB64));
  assert.throws(() => open(key, V.d2cFrame, 'c2d'));
});

test('pairingProof matches the daemon byte-for-byte', () => {
  assert.equal(pairingProof(V.secret, V.devicePubB64, V.daemonPubB64), V.expectedProof);
});

test('seal → open round-trips a client command (c2d)', () => {
  const key = deriveSessionKey(hexToBytes(V.devicePrivHex), hexToBytes(V.daemonPubHex), fromBase64(V.saltB64));
  const cmd = { type: 'send', sessionId: 's1', text: 'proceed with the deploy' };
  const frame = seal(key, 7, cmd, 'c2d');
  assert.deepEqual(open(key, frame, 'c2d'), cmd);
});

test('generateKeyPair + SPKI wrap/unwrap round-trips, and two peers derive the same key', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  // a raw pub -> SPKI b64 (wire) -> raw pub is lossless
  assert.deepEqual(rawPublicKeyFromB64(spkiPublicKeyB64(a.publicKey)), a.publicKey);
  // ECDH symmetry: both sides derive the same session key
  const salt = fromBase64(V.saltB64);
  const kA = deriveSessionKey(a.privateKey, b.publicKey, salt);
  const kB = deriveSessionKey(b.privateKey, a.publicKey, salt);
  assert.deepEqual(kA, kB);
});

test('base64 round-trips arbitrary bytes (matches standard RFC 4648)', () => {
  for (const len of [0, 1, 2, 3, 16, 33, 255]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes, `len ${len}`);
  }
});
