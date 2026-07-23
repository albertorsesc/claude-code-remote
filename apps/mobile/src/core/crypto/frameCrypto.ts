/**
 * React Native implementation of the protocol's E2E crypto: X25519 ECDH -> HKDF-SHA256 ->
 * AES-256-GCM, pure-JS via @noble, byte-compatible with the daemon's `@claudecode/protocol/node`.
 *
 * Imports ONLY the base `@claudecode/protocol` (the portable wire contract), NEVER
 * `@claudecode/protocol/node`, which pulls `node:crypto` and would break the Metro bundle. The AAD
 * format is taken from `frameAADString` there, so the direction:seq binding has one source of truth.
 *
 * Requires the `react-native-get-random-values` polyfill imported at app entry (index.js), before
 * any call here: @noble reads `globalThis.crypto.getRandomValues`.
 *
 * Verified byte-for-byte against `@claudecode/protocol/node` (session keys, sealed frames in both
 * directions, direction-binding rejection, pairing proof), see frameCrypto.test.ts.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { frameAADString, type Direction, type SealedFrame } from '@claudecode/protocol';

const INFO = utf8ToBytes('app.claudecode/v1');

// The fixed X25519 SPKI DER prefix (12 bytes). A public constant: DER-wrap our raw @noble public key
// so the daemon (which speaks DER over the wire) accepts it.
const SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

// --- base64 (RN has no Buffer; standard RFC 4648, chunk-free, matches node Buffer base64) ---
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = /* @__PURE__ */ (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i];
    const b = i + 1 < n ? bytes[i + 1] : 0;
    const c = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < n ? B64[c & 63] : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0, nbits = 0, oi = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v < 0) continue;
    bits = (bits << 6) | v;
    nbits += 6;
    if (nbits >= 8) { nbits -= 8; out[oi++] = (bits >> nbits) & 0xff; }
  }
  return out;
}

const aadBytes = (direction: Direction, seq: number): Uint8Array => utf8ToBytes(frameAADString(direction, seq));

/** A fresh X25519 identity for this device. Store `privateKey` in secure storage; send `publicKey`
 *  (DER-wrapped, see spkiPublicKeyB64) to the daemon during pairing. */
export function generateKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = randomBytes(32);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** DER-wrap a raw 32-byte X25519 public key as SPKI base64, the `devicePublicKey` wire format. */
export function spkiPublicKeyB64(rawPublicKey: Uint8Array): string {
  const der = new Uint8Array(SPKI_PREFIX.length + rawPublicKey.length);
  der.set(SPKI_PREFIX);
  der.set(rawPublicKey, SPKI_PREFIX.length);
  return toBase64(der);
}

/** Extract the raw 32-byte X25519 public key from an SPKI base64 (e.g. the daemon's `pk` from the QR). */
export function rawPublicKeyFromB64(spkiB64: string): Uint8Array {
  return fromBase64(spkiB64).slice(-32);
}

/** Derive the per-connection session key (X25519 ECDH + HKDF-SHA256). `salt` is the session_salt. */
export function deriveSessionKey(rawPrivateKey: Uint8Array, rawPeerPublicKey: Uint8Array, salt: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(rawPrivateKey, rawPeerPublicKey);
  return hkdf(sha256, shared, salt, INFO, 32);
}

export function seal(key: Uint8Array, seq: number, plaintext: unknown, direction: Direction): SealedFrame {
  const nonce = randomBytes(12);
  const ctAndTag = gcm(key, nonce, aadBytes(direction, seq)).encrypt(utf8ToBytes(JSON.stringify(plaintext)));
  return {
    n: toBase64(nonce),
    c: toBase64(ctAndTag.subarray(0, ctAndTag.length - 16)),
    t: toBase64(ctAndTag.subarray(ctAndTag.length - 16)),
    seq,
  };
}

/** @throws if tampered, wrong key, or sealed for the opposite direction. */
export function open<T = unknown>(key: Uint8Array, frame: SealedFrame, direction: Direction): T {
  const c = fromBase64(frame.c);
  const t = fromBase64(frame.t);
  const ctAndTag = new Uint8Array(c.length + t.length);
  ctAndTag.set(c);
  ctAndTag.set(t, c.length);
  const plain = gcm(key, fromBase64(frame.n), aadBytes(direction, frame.seq)).decrypt(ctAndTag);
  return JSON.parse(bytesToUtf8(plain)) as T;
}

/** HMAC-SHA256(secret, devicePublicKeyB64 || daemonPublicKeyB64), base64, the pairing proof. */
export function pairingProof(secret: string, devicePublicKeyB64: string, daemonPublicKeyB64: string): string {
  return toBase64(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(devicePublicKeyB64 + daemonPublicKeyB64)));
}
