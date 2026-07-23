/**
 * @claudecode/protocol, the PORTABLE wire contract shared by the daemon and every client.
 *
 * Pure and I/O-free by construction, and deliberately free of `node:crypto`: message types, the
 * sealed-frame format (frame.ts), the per-device seq/dedup primitives (sync.ts), control-char
 * sanitization, and the exhaustiveness helper. Because nothing here imports a Node built-in, this
 * base entry point is importable in React Native for the types and the frame format.
 *
 * The crypto IMPLEMENTATION is platform-specific and lives behind a separate entry point:
 * `@claudecode/protocol/node` (node:crypto, used by the daemon and CLI). The RN app supplies its own
 * byte-compatible implementation of the same operations against the same frame.ts contract.
 */
export * from './types.ts';
export * from './frame.ts';
export * from './sync.ts';
export * from './resend.ts';
export * from './client.ts';
export * from './sanitize.ts';
export * from './assert.ts';
