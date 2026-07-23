import {
  generateKeyPairSync, diffieHellman, createPublicKey, createPrivateKey,
  hkdfSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { frameAADString, type Direction, type SealedFrame } from './frame.ts';

/**
 * The `node:crypto` IMPLEMENTATION of the protocol's E2E crypto: X25519 ECDH -> HKDF-SHA256 ->
 * AES-256-GCM, plus X25519 key management. Node built-ins only; zero dependencies.
 *
 * Reachable via the `@claude-code-remote/protocol/node` subpath, NOT the base `@claude-code-remote/protocol`, the
 * base export is kept free of `node:crypto` so React Native can import the wire contract (frame.ts,
 * types) without pulling a Node built-in into its bundle. The daemon and CLI import from here; the
 * RN app supplies its own byte-compatible implementation of the same operations (verified pure-JS
 * @noble interop) against the shared frame.ts contract.
 */

// Re-exported so `@claude-code-remote/protocol/node` is the complete crypto surface (frame contract + the
// node implementation + the pairing proof), matching how the daemon/CLI consumed it before the split.
export * from './frame.ts';
export * from './pairing-proof.ts';

export interface KeyPair { publicKey: KeyObject; privateKey: KeyObject; }

export function generateIdentity(): KeyPair {
  return generateKeyPairSync('x25519');
}

export function exportPublic(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function importPublic(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, 'base64'), type: 'spki', format: 'der' });
}

export function exportPrivate(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

export function importPrivate(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, 'base64'), type: 'pkcs8', format: 'der' });
}

/**
 * Derive the shared session key. `salt` must be fresh per session (both sides contribute)
 * so a compromised long-term key cannot decrypt recorded past sessions.
 *
 * `info` is a frozen on-wire protocol version tag, NOT a product name, so it deliberately keeps its
 * original value across project renames. It is bound into every derived key and must stay byte-
 * identical across the daemon, the RN app (frameCrypto.ts), and the Python test crypto (_crypto.py);
 * changing it would alter every session key (a breaking wire change) and invalidate the fixed vectors.
 */
export function deriveSessionKey(
  privateKey: KeyObject,
  peerPublicKey: KeyObject,
  salt: Buffer,
  info = 'app.claudecode/v1',
): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: peerPublicKey });
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(info), 32));
}

export function seal(key: Buffer, seq: number, plaintext: unknown, direction: Direction): SealedFrame {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  // Direction + seq are authenticated but not encrypted: the transport needs seq to order and replay.
  cipher.setAAD(Buffer.from(frameAADString(direction, seq), 'utf8'));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), 'utf8')),
    cipher.final(),
  ]);
  return {
    n: nonce.toString('base64'),
    c: body.toString('base64'),
    t: cipher.getAuthTag().toString('base64'),
    seq,
  };
}

/** @throws if the frame was tampered with, truncated, sealed under a different key, or sealed for
 *  the opposite direction (e.g. a daemon→client frame reflected back into the daemon). */
export function open<T = unknown>(key: Buffer, frame: SealedFrame, direction: Direction): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(frame.n, 'base64'));
  decipher.setAAD(Buffer.from(frameAADString(direction, frame.seq), 'utf8'));
  decipher.setAuthTag(Buffer.from(frame.t, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(frame.c, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8')) as T;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
