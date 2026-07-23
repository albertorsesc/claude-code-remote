/**
 * Per-device monotonic sequence counter.
 *
 * Used to be also a ciphertext replay buffer (buffer of sealed SealedFrames + replayFrom), but
 * that design is provably unusable across a reconnect: a fresh session key is derived every
 * `hello` (forward secrecy, deliberate, see packages/daemon/src/index.ts), so ciphertext sealed under a
 * dead connection's key is undecryptable garbage the moment that connection is gone. Nothing in
 * production ever called that path either, only its own unit test did. Cross-reconnect replay
 * now lives in packages/daemon/src/replay.ts (DeviceReplayLog), which stores plaintext ServerEvents keyed
 * by seq and re-seals them under whatever key the new connection derives. This class is now just
 * the seq counter that both replay.ts and the live send path share.
 *
 * A phone loses its socket constantly: backgrounding, tunnels, lifts. Reconnect must not lose an
 * approval request, and must never let a dropped acknowledgement read as consent.
 *
 * Remote Control shipped a regression in exactly this area before v2.1.207, an update sent
 * during reconnection could be lost, leaving a finished task displayed as still running.
 */
export class OutboundStream {
  private seq: number;

  // startSeq seeds the counter. The daemon uses 0 (per-device, reset on restart). A CLI client
  // seeds from a persisted per-device high-water so seq keeps climbing across separate process
  // invocations, the daemon's inbound dedup is per-device and persistent, so a fresh process
  // restarting seq at 1 would collide with a prior process's seq 1 and get its command deduped.
  constructor(startSeq = 0) {
    this.seq = startSeq;
  }

  next(): number {
    return ++this.seq;
  }

  get current(): number {
    return this.seq;
  }
}

/**
 * Inbound deduplication. A client retrying after an uncertain send must not cause a
 * double-decide; the broker's compare-and-swap already makes that safe, but dropping
 * duplicates early keeps the audit trail honest about who actually decided.
 */
export class InboundStream {
  private seen = new Set<number>();
  private highest = 0;

  accept(seq: number): boolean {
    if (seq <= this.highest && this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.highest) this.highest = seq;
    if (this.seen.size > 5000) {
      for (const s of this.seen) {
        if (s < this.highest - 2000) this.seen.delete(s);
      }
    }
    return true;
  }

  get lastSeq(): number {
    return this.highest;
  }
}
