/**
 * The out-of-band pairing code for a second machine.
 *
 * `begin_pair` returns the daemon's one-time secret to its caller, so it is served on the LOCAL
 * socket only: handing that secret to a network peer over the very channel it authenticates would
 * make pairing self-service. A second CLI machine therefore cannot ask the daemon for
 * a secret over the network, it must receive one OUT OF BAND, exactly like a phone reading a QR off
 * the daemon's screen.
 *
 * This module is that out-of-band channel for the CLI: the operator runs `cc pair-code` ON the
 * daemon's machine (a local `begin_pair`), which prints the QR payload as a single copy-pasteable
 * token; the operator carries it to the second machine and runs `CC_PAIR_CODE=<token> cc pair`,
 * which redeems it against `complete_pair` over the network, the daemon never disclosed the secret
 * over the wire. The daemon side is unchanged: `complete_pair` already works from anywhere for a
 * device that holds a valid secret (tests/integration/pairing_transport.py case C).
 *
 * Pure and I/O-free on purpose: cc.ts is an entry point that opens sockets on import, so the pieces
 * worth testing (the encoding and the address parsing) live here where a unit test can reach them.
 */

/** The daemon's QR payload, the content of a pairing code. Same shape `Identity.beginPairing` emits. */
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

/** Encode the daemon's QR JSON as a single shell-safe token (base64url). */
export function encodePairCode(qrJson: string): string {
  return Buffer.from(qrJson, 'utf8').toString('base64url');
}

/**
 * Decode a pairing code back to its payload. Tolerant of surrounding whitespace (a pasted token
 * often carries a trailing newline); strict about the fields that must be present, so a malformed
 * code fails loudly here rather than producing a half-populated payload that fails later as a
 * confusing pairing error.
 *
 * @throws if the token is not decodable or is missing pk/s/addr.
 */
export function decodePairCode(code: string): PairPayload {
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8'));
  } catch {
    throw new Error('CC_PAIR_CODE is not a valid pairing code (could not decode). ' +
      'Regenerate it on the daemon machine with `cc pair-code`.');
  }
  if (typeof payload?.pk !== 'string' || typeof payload?.s !== 'string' || typeof payload?.addr !== 'string') {
    throw new Error('CC_PAIR_CODE is missing required fields (pk/s/addr), it is not a pairing code.');
  }
  return payload as PairPayload;
}

/**
 * The `host:port` a remote client should dial, extracted from a `tcp://host:port` advertised
 * address. Returns null for any non-TCP address (e.g. `unix://…`), which means the daemon has no
 * network listener and a second machine cannot reach it at all.
 */
export function tcpTargetFromAddr(addr: string): string | null {
  const m = /^tcp:\/\/(.+)$/.exec(addr);
  return m ? m[1] : null;
}
