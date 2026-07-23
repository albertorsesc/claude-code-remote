/**
 * Adapts the RN crypto (frameCrypto) to the `SessionCrypto` port that the shared `ReliableClient`
 * drives. It binds this device's private key and the daemon's public key once, so the reliability
 * engine can seal, open, and derive without ever seeing key material: the engine holds the derived
 * session key only as an opaque handle, which here is the raw 32-byte AES key.
 *
 * Imports ONLY the base `@claude-code-remote/protocol` and the RN crypto, never
 * `@claude-code-remote/protocol/node`. This is the whole point of the crypto seam: the daemon and the
 * app run different implementations of the same wire contract, and only the app-safe one is bundled.
 */
import type { SessionCrypto } from '@claude-code-remote/protocol';
import { deriveSessionKey, seal, open, fromBase64 } from '../crypto/frameCrypto.ts';

/**
 * @param devicePrivateKeyRaw the 32-byte X25519 private key from secure storage.
 * @param daemonPublicKeyRaw   the daemon's raw 32-byte X25519 public key (from the pairing payload).
 */
export function createSessionCrypto(devicePrivateKeyRaw: Uint8Array, daemonPublicKeyRaw: Uint8Array): SessionCrypto {
  return {
    deriveKey: (saltB64) => deriveSessionKey(devicePrivateKeyRaw, daemonPublicKeyRaw, fromBase64(saltB64)),
    seal: (key, seq, plaintext, direction) => seal(key as Uint8Array, seq, plaintext, direction),
    open: (key, frame, direction) => open(key as Uint8Array, frame, direction),
  };
}
