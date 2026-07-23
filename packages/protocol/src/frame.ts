/**
 * The E2E wire-format CONTRACT: the sealed-frame shape, the direction, the authenticated-data
 * construction, and the field policy. Pure and platform-agnostic on purpose, NO `node:crypto`, no
 * dependencies, so every peer imports the same contract and each platform supplies its own byte-
 * compatible crypto IMPLEMENTATION against it:
 *
 *   - the daemon and CLI  -> `@claude-code-remote/protocol/node`  (node:crypto)
 *   - the React Native app -> its own module              (pure-JS @noble/*)
 *   - the Python tests     -> tests/integration/_crypto.py
 *
 * Because this file has no `node:crypto`, `@claude-code-remote/protocol` (which re-exports it) is importable
 * in React Native for the types and the frame format, without pulling a Node built-in into the
 * bundle. The crypto implementation is imported separately, per platform.
 */

export interface SealedFrame {
  /** 12-byte GCM nonce, base64. Never reused under one key. */
  n: string;
  /** Ciphertext, base64. */
  c: string;
  /** 16-byte GCM auth tag, base64. */
  t: string;
  /** Monotonic sequence, authenticated as AAD (with the direction). Prevents reorder/replay. */
  seq: number;
}

/**
 * Which way a frame travels: daemon→client (`d2c`) or client→daemon (`c2d`).
 *
 * One session key serves both directions, so without binding the direction, a frame the daemon
 * sealed FOR the client authenticates perfectly if reflected back INTO the daemon, an on-path relay
 * (the threat model treats relays as untrusted) could bounce a daemon→client frame at the daemon,
 * which would accept it, advance the inbound watermark, and emit a genuine sealed ack, so a dropped
 * decision could read as consent (the exact failure sync.ts warns about). Binding the direction into
 * the authenticated data makes a reflected frame fail to open. The tag is authenticated, never
 * transmitted, the wire frame's shape is unchanged.
 *
 * Required, not defaulted: the daemon seals `d2c` and opens `c2d`, the client is the mirror, so
 * there is no single correct default and an omitted argument must be a type error, not a silent
 * direction-blind seal.
 */
export type Direction = 'd2c' | 'c2d';

/**
 * The authenticated associated data string for a frame: its direction and sequence, bound together.
 * Both peers MUST build this identically (as UTF-8 bytes of `${direction}:${seq}`) or authentication
 * fails. Exported because every platform's crypto implementation needs it to seal/open compatibly.
 */
export function frameAADString(direction: Direction, seq: number): string {
  return `${direction}:${seq}`;
}

/**
 * Explicit inventory of what a relay can and cannot see. Asserted by the transport test, so adding
 * an unencrypted field fails CI rather than shipping quietly.
 *
 * Honest description of the relay: "sees metadata only". NOT "zero-knowledge".
 */
export const FIELD_POLICY = {
  /** Visible to a relay. Keep this list as short as the protocol allows. */
  metadata: [
    'seq',       // ordering and replay
    'n', 'c', 't',// the sealed envelope itself
    'deviceId',  // routing to the right paired device
    'ts',        // transport-level timing
  ],
  /** Everything else is inside the envelope. Non-exhaustive by design: default is encrypted. */
  encrypted: [
    'sessions', 'transcript', 'toolInput', 'toolName', 'description',
    'cwd', 'label', 'prompt', 'decision', 'reason', 'diff', 'fileContent',
    'model', 'claudeSessionId', 'apiKeys', 'env',
    // The device's push token (from register_push). Sealed so a relay never sees it, it is a
    // routing credential for a third-party push service, not something the tailnet should learn.
    'token',
    // The command-redelivery cumulative ack. Encrypted so a relay can't see a device's
    // command-sent count, deliberately NOT in session_salt (plaintext) for that reason.
    'upTo',
  ],
} as const;
