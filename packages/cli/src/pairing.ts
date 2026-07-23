/**
 * The out-of-band pairing code, CLI side.
 *
 * `begin_pair` returns the daemon's one-time secret to its caller, so it is served on the LOCAL
 * socket only: handing that secret to a network peer over the very channel it authenticates would
 * make pairing self-service. A second CLI machine therefore cannot ask the daemon for a secret over
 * the network, it must receive one OUT OF BAND, exactly like a phone reading a QR off the daemon's
 * screen. The operator runs `cc pair-code` ON the daemon's machine (a local `begin_pair`), which
 * prints the QR payload as a single copy-pasteable token; the operator carries it to the second
 * machine and runs `CC_PAIR_CODE=<token> cc pair`, which redeems it against `complete_pair` over the
 * network. The daemon never disclosed the secret over the wire.
 *
 * The payload FORMAT (the shape, its validation, address parsing) lives in the shared kernel so the
 * daemon's encoder and every decoder (the CLI here, the RN app) stay in lockstep. This module is just
 * the base64url transport around it, using node Buffer.
 */
import { parsePairPayload, tcpTargetFromAddr, type PairPayload } from '@claude-code-remote/protocol';

export { tcpTargetFromAddr, type PairPayload };

/** Encode the daemon's QR JSON as a single shell-safe token (base64url). */
export function encodePairCode(qrJson: string): string {
  return Buffer.from(qrJson, 'utf8').toString('base64url');
}

/**
 * Decode a pairing code back to its payload. Tolerant of surrounding whitespace (a pasted token often
 * carries a trailing newline); strict about the required fields via the shared `parsePairPayload`.
 *
 * @throws if the token is not decodable or is missing pk/s/addr.
 */
export function decodePairCode(code: string): PairPayload {
  return parsePairPayload(Buffer.from(code.trim(), 'base64url').toString('utf8'));
}
