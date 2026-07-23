import { createHmac } from 'node:crypto';

/**
 * The pairing proof: HMAC-SHA256(secret, devicePublicKey || daemonPublicKey), base64.
 *
 * Shared by both sides of the wire, the client computes it to prove possession of the one-time
 * secret, the daemon computes the expected value to verify. Binding the HMAC to both public keys
 * is what stops a relay substituting its own key (the classic MITM on an unauthenticated ECDH).
 * Pure and dependency-free, which is why it lives in the protocol kernel rather than the daemon's
 * Identity class.
 */
export function pairingProof(secret: string, devicePublicKey: string, daemonPublicKey: string): string {
  return createHmac('sha256', secret).update(devicePublicKey + daemonPublicKey).digest('base64');
}
