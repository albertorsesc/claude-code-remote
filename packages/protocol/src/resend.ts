/**
 * Client-side reverse buffer for command redelivery, the mirror of the daemon's DeviceReplayLog
 * (packages/daemon/src/infrastructure/replay.ts). Holds sent-but-unacked commands as PLAINTEXT keyed
 * by their outbound seq, so they can be re-sealed under a fresh session key on reconnect (same
 * forward-secrecy reason the daemon buffers plaintext, not ciphertext).
 *
 * Lives in the portable kernel next to its mirror, InboundStream (sync.ts): every client, the CLI
 * today, the React Native app next, needs the identical resend semantics, and this class touches no
 * platform surface, so it belongs beside the seq/dedup primitives rather than in any one client.
 *
 * Bounded and hard-fail-on-overflow, not drop-oldest: this is a control plane. Silently dropping a
 * queued `decide`/`spawn`/`interrupt` an operator issued would be worse than refusing a new one,
 * and drop-oldest could discard a command the daemon already processed, desyncing the ack
 * accounting ("everything buffered will be delivered" is the invariant the ack math depends on).
 *
 * The cap (256) is deliberately << the daemon's InboundStream dedup window (~2000): every buffered,
 * hence resendable, seq stays inside that window, so a resent already-processed command is always
 * recognized and dropped rather than re-executed.
 */
export class ResendBuffer {
  private pendingCmds = new Map<number, unknown>();
  private capacity: number;

  // Explicit assignment, not a parameter property: Node's strip-only TypeScript mode rejects
  // parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX): node --check accepts them but strip-only import throws.
  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  /** @returns false if the buffer is full, the caller must hard-fail rather than lose the command. */
  add(seq: number, cmd: unknown): boolean {
    if (this.pendingCmds.size >= this.capacity) return false;
    this.pendingCmds.set(seq, cmd);
    return true;
  }

  /** Drop every command with seq <= n (the daemon has confirmed processing them). */
  ackUpTo(n: number) {
    for (const seq of this.pendingCmds.keys()) {
      if (seq <= n) this.pendingCmds.delete(seq);
    }
  }

  /** Unacked commands in ascending seq order, resent at their ORIGINAL seq so the daemon dedups. */
  pending(): [number, unknown][] {
    return [...this.pendingCmds.entries()].sort((a, b) => a[0] - b[0]);
  }

  get size(): number {
    return this.pendingCmds.size;
  }

  get isFull(): boolean {
    return this.pendingCmds.size >= this.capacity;
  }
}
