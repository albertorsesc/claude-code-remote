import type { ServerEvent } from '@claude-code-remote/protocol';

interface ReplayEntry {
  seq: number;
  event: ServerEvent;
}

/**
 * Per-device plaintext event log for cross-reconnect replay. Deliberately plaintext, not
 * SealedFrame: OutboundStream's old ciphertext buffer was sealed under a per-connection
 * ephemeral key (forward secrecy, a fresh salt every `hello`), so ciphertext buffered under an
 * old connection's key is undecryptable junk after reconnect. This buffer stores pre-seal events
 * so the daemon can re-seal them under whatever key the new connection derives.
 *
 * Eviction, two layers (a single layer isn't sufficient):
 * 1. Tied to pairing.ts's revoke() (not wired here, see revoke()'s own comment for the future
 *    call site): answers the deliberate-removal case directly.
 * 2. A global cap on the number of DEVICES holding a live buffer (not a per-device time TTL):
 *    "still paired" alone has no ceiling, a device paired once and never reconnecting for
 *    months is never revoked. A count-based cap bounds worst-case memory unconditionally
 *    regardless of wall-clock time; a TTL either needs a background sweep timer (the same
 *    fragile-timer category replaced for approvals) or lazy
 *    checks that don't bound the worst case between them. Matches this project's existing
 *    precedent: InboundStream's bounded ~6,000-seq window (documented as L1), bounded, not
 *    unlimited, is the answer to this class of problem.
 */
export class DeviceReplayLog {
  private byDevice = new Map<string, { events: ReplayEntry[]; lastSeenAt: number }>();
  private maxDevices: number;
  private maxEventsPerDevice: number;

  // Explicit assignment, not a parameter property: Node's strip-only TypeScript mode rejects
  // parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX): node --check accepts them but strip-only import throws.
  constructor(maxDevices = 200, maxEventsPerDevice = 200) {
    this.maxDevices = maxDevices;
    this.maxEventsPerDevice = maxEventsPerDevice;
  }

  /**
   * Call with the seq OutboundStream.next() actually issued for this event, never
   * self-assigned, or replay would desync from what the client actually received live.
   * @returns the deviceId evicted by the global LRU cap, if any, so the caller (deviceSessions.ts)
   * can keep its own per-device OutboundStream map's lifecycle in sync with this one.
   */
  record(deviceId: string, seq: number, ev: ServerEvent): string | null {
    let entry = this.byDevice.get(deviceId);
    let evicted: string | null = null;
    if (!entry) {
      entry = { events: [], lastSeenAt: Date.now() };
      this.byDevice.set(deviceId, entry);
      evicted = this.evictLRUIfOverCap();
    }
    entry.events.push({ seq, event: ev });
    if (entry.events.length > this.maxEventsPerDevice) {
      entry.events.splice(0, entry.events.length - this.maxEventsPerDevice);
    }
    return evicted;
  }

  /**
   * Events after `lastSeq`, same gap-detection contract the old OutboundStream.replayFrom had
   * (moved here, not reinvented): `gap: true` means the client fell too far behind and the
   * buffer no longer covers it, the caller must fall back to a full resync, not a partial
   * replay. `currentSeq` is an explicit parameter (from the caller's OutboundStream), not
   * inferred from this buffer's own tail, because the buffer is capped and can legitimately be
   * shorter than what's actually been sent.
   */
  replayFrom(deviceId: string, currentSeq: number, lastSeq: number): { events: ReplayEntry[]; gap: boolean } {
    // `gap: false` with no events is the daemon's way of saying "you are current, here is nothing".
    // That answer is only safe when the client's claim is actually possible, because the caller
    // sends NO full resync on the strength of it, no sessions, no jobs, and no pending approvals.
    // A client claiming a seq this process never issued is therefore never trusted as caught up:
    // that claim is impossible, so the honest response is a full resync, not silence.
    if (lastSeq > currentSeq) return { events: [], gap: true };
    // The one believable "nothing new" case: the client is exactly level with what we've sent.
    if (lastSeq === currentSeq) return { events: [], gap: false };

    // Past here the client is genuinely behind, so we owe it events. If we cannot produce them,
    // that is a gap, never a claim that it is up to date.
    const entry = this.byDevice.get(deviceId);
    if (!entry) return { events: [], gap: true };
    const oldest = entry.events[0]?.seq;
    if (oldest === undefined) return { events: [], gap: true };
    if (lastSeq + 1 < oldest) return { events: entry.events.slice(), gap: true };
    return { events: entry.events.filter((e) => e.seq > lastSeq), gap: false };
  }

  /** Call on a successful `hello`, marks the device as recently active for LRU purposes. */
  touch(deviceId: string) {
    const entry = this.byDevice.get(deviceId);
    if (entry) entry.lastSeenAt = Date.now();
  }

  /** Call on pairing.ts's revoke(), the deliberate-removal case. */
  evict(deviceId: string) {
    this.byDevice.delete(deviceId);
  }

  private evictLRUIfOverCap(): string | null {
    if (this.byDevice.size <= this.maxDevices) return null;
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, entry] of this.byDevice) {
      if (entry.lastSeenAt < oldestAt) {
        oldestAt = entry.lastSeenAt;
        oldestId = id;
      }
    }
    if (oldestId) this.byDevice.delete(oldestId);
    return oldestId;
  }

  get deviceCount(): number {
    return this.byDevice.size;
  }
}
