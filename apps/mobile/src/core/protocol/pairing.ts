/**
 * The mobile pairing flow, everything except the camera and the socket. A screen scans a QR to get
 * the base64url code, calls `decodePairCode`, then `startPairing` to mint this device's identity and
 * build the `complete_pair` message, sends it over the tailnet, and on the daemon's `paired` reply
 * calls `deviceRecordFromPaired` to get the record to persist in secure storage.
 *
 * The payload format and its validation come from the shared kernel (`parsePairPayload`), so this
 * decoder cannot drift from the daemon's encoder. Only the base64url transport is done here, over the
 * RN base64 (which strips the url-safe alphabet, so `-`/`_` are mapped to `+`/`/` first).
 */
import { parsePairPayload, type PairPayload, type SessionCrypto } from '@claude-code-remote/protocol';
import { bytesToUtf8 } from '@noble/ciphers/utils.js';
import {
  generateKeyPair, spkiPublicKeyB64, rawPublicKeyFromB64, pairingProof, toBase64, fromBase64,
} from '../crypto/frameCrypto.ts';
import { createSessionCrypto } from './sessionCrypto.ts';

/** A paired device's persisted identity. Goes in secure storage; never leaves the device. */
export interface DeviceRecord {
  deviceId: string;
  /** The device's raw X25519 private key, base64. */
  devicePrivateKey: string;
  /** The device's public key, SPKI DER base64 (what the daemon registered). */
  devicePublicKey: string;
  /** The daemon's public key, SPKI DER base64 (taken from the pairing payload). */
  daemonPublicKey: string;
  /** Where to reach the daemon, `host:port` (from the pairing payload's tcp:// address). */
  daemonAddress: string;
}

/** Decode a scanned pairing code (base64url of the daemon's QR payload) into a validated payload. */
export function decodePairCode(code: string): PairPayload {
  const standardB64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  return parsePairPayload(bytesToUtf8(fromBase64(standardB64)));
}

/**
 * The WebSocket URL to connect to, from the daemon's advertised address. The app talks WebSocket, so
 * the address is a `ws://host:port` URL used verbatim; returns null for any non-WebSocket address
 * (which means the daemon has no WebSocket listener and this phone cannot reach it).
 */
export function wsUrlFromAddr(addr: string): string | null {
  return /^wss?:\/\/.+/.test(addr) ? addr : null;
}

export interface PairingAttempt {
  /** The `ws://host:port` URL to connect to, or null if the daemon advertised no WebSocket address. */
  target: string | null;
  /** The device keypair minted for this pairing; persist its private key only on success. */
  device: { privateKey: Uint8Array; publicKey: Uint8Array };
  /** The `complete_pair` message to send once the socket is open. */
  completePair: { type: 'complete_pair'; devicePublicKey: string; deviceName: string; proof: string };
}

/**
 * Mint a device identity for this pairing and build the `complete_pair` message. The proof binds both
 * public keys, so a relay cannot substitute its own (the MITM on an unauthenticated ECDH); it is
 * computed with the same HMAC the daemon verifies with, so a correct proof is accepted.
 */
export function startPairing(payload: PairPayload, deviceName: string): PairingAttempt {
  const device = generateKeyPair();
  const devicePublicKeyB64 = spkiPublicKeyB64(device.publicKey);
  const proof = pairingProof(payload.s, devicePublicKeyB64, payload.pk);
  return {
    target: wsUrlFromAddr(payload.addr),
    device,
    completePair: { type: 'complete_pair', devicePublicKey: devicePublicKeyB64, deviceName, proof },
  };
}

/**
 * Build the record to persist after the daemon replies `paired`. The daemon public key is taken from
 * the pairing payload (already authenticated by the proof), not from the network reply.
 */
export function deviceRecordFromPaired(deviceId: string, attempt: PairingAttempt, payload: PairPayload): DeviceRecord {
  if (!attempt.target) {
    // A daemon we cannot reach over WebSocket is not worth persisting; the pairing screen guards this too.
    throw new Error('the daemon advertised no WebSocket address; enable CC_CLIENT_WS_PORT on it to pair a phone.');
  }
  return {
    deviceId,
    devicePrivateKey: toBase64(attempt.device.privateKey),
    devicePublicKey: attempt.completePair.devicePublicKey,
    daemonPublicKey: payload.pk,
    daemonAddress: attempt.target,
  };
}

/** Reconstruct the SessionCrypto for a stored device, to open a connection after pairing. */
export function sessionCryptoFromRecord(record: DeviceRecord): SessionCrypto {
  return createSessionCrypto(fromBase64(record.devicePrivateKey), rawPublicKeyFromB64(record.daemonPublicKey));
}
