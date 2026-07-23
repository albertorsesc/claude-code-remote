/**
 * The out-of-band pairing-code FORMAT, shared by every consumer that reads one: the CLI redeeming a
 * code on a second machine, and the mobile app decoding a scanned QR. Only the format lives here (the
 * payload shape, its validation, and address parsing), all pure and portable. The base64url transport
 * around it stays platform-specific: the CLI uses node Buffer, the RN app uses its own base64. Sharing
 * the format is what stops the daemon's encoder and the app's decoder from drifting apart.
 */

/** The daemon's QR payload, the content of a pairing code. Same shape the daemon's pairing emits. */
export interface PairPayload {
  /** Payload version. */
  v: number;
  /** The daemon's advertised address, e.g. `tcp://100.101.102.103:7777`. */
  addr: string;
  /** The daemon's public key, DER base64, needed to compute the proof and to derive session keys. */
  pk: string;
  /** The one-time pairing secret. */
  s: string;
}

/**
 * Validate an already-decoded pairing-code JSON string into a `PairPayload`. Strict about the fields
 * that must be present, so a malformed code fails loudly here rather than producing a half-populated
 * payload that surfaces later as a confusing pairing error.
 *
 * @throws if the string is not valid JSON, or is missing pk/s/addr.
 */
export function parsePairPayload(json: string): PairPayload {
  let payload: any;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error('not a valid pairing code (could not decode).');
  }
  if (typeof payload?.pk !== 'string' || typeof payload?.s !== 'string' || typeof payload?.addr !== 'string') {
    throw new Error('pairing code is missing required fields (pk/s/addr).');
  }
  return payload as PairPayload;
}

/**
 * The `host:port` a remote client should dial, extracted from a `tcp://host:port` advertised address.
 * Returns null for any non-TCP address (e.g. `unix://…`), which means the daemon has no network
 * listener and a remote client cannot reach it at all.
 */
export function tcpTargetFromAddr(addr: string): string | null {
  const m = /^tcp:\/\/(.+)$/.exec(addr);
  return m ? m[1] : null;
}
