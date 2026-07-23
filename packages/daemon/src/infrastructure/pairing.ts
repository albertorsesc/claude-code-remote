import { randomBytes, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateIdentity, exportPublic, exportPrivate, importPrivate, importPublic,
  deriveSessionKey, constantTimeEqual, pairingProof, type KeyPair,
} from '@claude-code-remote/protocol/node';
import type { PairingOutcome, PairingService } from '../application/ports.ts';

/**
 * Device pairing.
 *
 * The QR code carries the daemon's public key and a short-lived one-time secret. The phone
 * proves possession of that secret with an HMAC over both public keys, which binds the
 * exchange to these two identities and stops a relay from substituting its own key
 * (the classic MITM on an unauthenticated ECDH).
 *
 * Deliberately no trust-on-first-use: an unpaired device is rejected, not remembered.
 */

/**
 * Why a pairing attempt was refused. Reported to the daemon log only, never to the client, whose
 * answer stays a uniform `pair_failed` so a caller cannot probe which precondition it missed.
 * `no_pending_pairing` covers the superseded case too: a newer begin_pair burns the previous slot.
 */
export type PairingResult = PairingOutcome;

export interface PairedDevice {
  deviceId: string;
  name: string;
  publicKey: string;
  pairedAt: number;
}

interface Store {
  identity: { publicKey: string; privateKey: string };
  devices: PairedDevice[];
}

/** One-time pairing secret. Short TTL because a QR on screen is a live credential. */
const PAIRING_TTL_MS = 3 * 60 * 1000;

export class Identity implements PairingService {
  // PRIVATE, deliberately. The daemon's private key is the whole security model, so it does not
  // leave this class: deriveSessionKey() below performs the ECDH here and returns only the result.
  private readonly keys: KeyPair;
  private devices: PairedDevice[];
  private storePath: string;
  private pendingPairing: { secret: string; expiresAt: number } | null = null;

  private constructor(keys: KeyPair, devices: PairedDevice[], storePath: string) {
    this.keys = keys;
    this.devices = devices;
    this.storePath = storePath;
  }

  /**
   * Load the daemon identity, or create one on genuine first run.
   *
   * Deliberately does NOT catch broadly. Silently regenerating on an unreadable store
   * would rotate the identity and orphan every paired device with no signal, a corrupt
   * file or a permissions problem must fail loudly, not quietly revoke trust.
   * Only "file does not exist" means first run.
   */
  static load(storePath: string): Identity {
    let raw: Store;
    try {
      raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Store;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        const id = new Identity(generateIdentity(), [], storePath);
        id.persist();
        return id;
      }
      throw new Error(
        `identity store at ${storePath} exists but could not be read (${err?.message}). ` +
        `Refusing to generate a new identity: that would silently unpair every device. ` +
        `Fix or explicitly delete the file.`,
      );
    }

    if (!raw?.identity?.privateKey) {
      throw new Error(`identity store at ${storePath} is missing identity.privateKey`);
    }

    const privateKey = importPrivate(raw.identity.privateKey);
    // Derive the public key rather than trusting the stored copy: a tampered public key
    // in the store must not be able to stand in for the real identity.
    // @types/node 26.x omits KeyObject from createPublicKey's parameter type, but Node documents
    // it explicitly: "if key is a KeyObject with type 'private', the public key is derived from the
    // given private key". The runtime behaviour is the documented one, so the assertion is against
    // an incomplete type definition, not against Node.
    const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);
    return new Identity({ publicKey, privateKey }, raw.devices ?? [], storePath);
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const store: Store = {
      identity: {
        publicKey: exportPublic(this.keys.publicKey),
        privateKey: exportPrivate(this.keys.privateKey),
      },
      devices: this.devices,
    };
    // 0600: the private key is the whole security model.
    fs.writeFileSync(this.storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.chmodSync(this.storePath, 0o600);
  }

  get publicKeyB64(): string {
    return exportPublic(this.keys.publicKey);
  }

  /** Number of paired devices, for the operational cap. */
  pairedCount(): number {
    return this.devices.length;
  }

  /**
   * Derives the per-connection session key for a paired device (X25519 ECDH + HKDF).
   *
   * Lives here rather than at the call site so the private key never crosses a module boundary.
   * The caller supplies the device's public key and the per-connection salt, and receives only the
   * derived symmetric key.
   */
  deriveSessionKey(devicePublicKeyB64: string, salt: Buffer): Buffer {
    return deriveSessionKey(this.keys.privateKey, importPublic(devicePublicKeyB64), salt);
  }

  /**
   * Begin pairing. Returns the payload to render as a QR code.
   *
   * There is exactly ONE pending pairing at a time, and a new call REPLACES any outstanding one:
   * pairing is a one-QR-on-screen-at-a-time human flow, and keeping several live secrets would
   * mean several simultaneously-valid credentials. Concurrent pairing is therefore impossible by
   * construction, and it fails closed, a device holding the superseded secret is rejected
   * (verified: two begin_pair calls, only the newest secret completes).
   *
   * The superseded device gets a plain `pair_failed`, the same answer given for an expired secret
   * or a bad proof, deliberately, so a caller cannot probe which precondition it missed. The
   * daemon log does distinguish them (see completePairing's PairingResult), which is what makes
   * "my phone will not pair" diagnosable without leaking anything to the client.
   */
  beginPairing(address: string): { qr: string; secret: string; expiresAt: number } {
    const secret = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pendingPairing = { secret, expiresAt };
    const qr = JSON.stringify({ v: 1, addr: address, pk: this.publicKeyB64, s: secret });
    return { qr, secret, expiresAt };
  }

  /**
   * Complete pairing. `proof` must be HMAC-SHA256(secret, devicePub || daemonPub).
   * @returns the registered device, or why the attempt was refused.
   */
  completePairing(devicePublicKey: string, deviceName: string, proof: string): PairingResult {
    const p = this.pendingPairing;
    // Distinguished for the OPERATOR, not for the client: the wire answer stays a uniform
    // `pair_failed` because telling a caller which precondition it missed helps an attacker
    // enumerate. Previously nothing recorded the difference anywhere, so a phone failing to pair
    // because a newer QR had superseded its secret looked exactly like a broken install.
    if (!p) return { ok: false, reason: 'no_pending_pairing' };
    if (Date.now() > p.expiresAt) return { ok: false, reason: 'expired' };

    const expected = pairingProof(p.secret, devicePublicKey, this.publicKeyB64);
    if (!constantTimeEqual(proof, expected)) return { ok: false, reason: 'bad_proof' };

    // One-time: burn the secret whether or not anything else follows.
    this.pendingPairing = null;

    const device: PairedDevice = {
      deviceId: randomBytes(8).toString('hex'),
      name: deviceName,
      publicKey: devicePublicKey,
      pairedAt: Date.now(),
    };
    this.devices.push(device);
    this.persist();
    return { ok: true, device };
  }

  find(deviceId: string): PairedDevice | undefined {
    return this.devices.find((d) => d.deviceId === deviceId);
  }

  list(): PairedDevice[] {
    return this.devices.slice();
  }

  /**
   * Called from commands.ts's `revoke` case, paired with `deviceSessions.evict(id)` at that
   * same call site (index.ts), this method only owns identity/trust custody, not session or
   * replay bookkeeping, so it doesn't reach into DeviceReplayLog itself.
   */
  revoke(deviceId: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    if (this.devices.length === before) return false;
    this.persist();
    return true;
  }
}
