import { OutboundStream, InboundStream } from '@claude-code-remote/protocol';
import { DeviceReplayLog } from './replay.ts';
import type { ServerEvent } from '@claude-code-remote/protocol';

export interface ResumeResult {
  resume: { events: { seq: number; event: ServerEvent }[] } | null;
}

/**
 * Per-device seq + replay bookkeeping across reconnects, composes the already-tested
 * OutboundStream (seq counter) and DeviceReplayLog (plaintext event buffer + eviction), kept
 * separate from index.ts (sockets/lifecycle/wiring) and commands.ts (dispatch) since this is a
 * distinct concern from both.
 *
 * Critical invariant, found by a failing integration test before it shipped: recordSent() must
 * be called for a device EVEN WHILE IT'S DISCONNECTED, or replay has nothing to catch up on.
 * broadcast() (index.ts) calls recordSent() for every device this process has ever seen
 * (knownDeviceIds()), not just currently-connected ones, only the actual ciphertext
 * transmission is gated on being connected.
 */
export class DeviceSessionRegistry {
  private outbound = new Map<string, OutboundStream>();
  private log: DeviceReplayLog;
  /**
   * Client→daemon dedup, per device, surviving reconnects, this is what makes command
   * redelivery SAFE: a command resent after a dropped connection is dropped here instead of
   * re-executed (a resent `spawn` must not create a second session). Deliberately bounded by
   * the paired-device cap (a device must be paired to send a command, and pairing is capped),
   * NOT by the replay LRU: LRU-evicting then lazily recreating an InboundStream (highest=0)
   * would re-accept a resent seq and re-execute the command, the exact hazard this prevents.
   */
  private inbound = new Map<string, InboundStream>();
  /** Contiguous "successfully handled through" mark per device, plus any successes that landed
   *  ahead of a gap. See markProcessed/ackLevel. */
  private processed = new Map<string, { through: number; ahead: Set<number> }>();

  constructor(maxDevices?: number, maxEventsPerDevice?: number) {
    this.log = new DeviceReplayLog(maxDevices, maxEventsPerDevice);
  }

  private outboundFor(deviceId: string): { out: OutboundStream; isNew: boolean } {
    let out = this.outbound.get(deviceId);
    const isNew = !out;
    if (!out) {
      out = new OutboundStream();
      this.outbound.set(deviceId, out);
    }
    return { out, isNew };
  }

  /**
   * Called on every `hello`. `resume: null` means "send today's full resync", first-ever
   * hello, a `lastSeq` claimed against a device this PROCESS has never sent to (the
   * daemon-restart guard, identity persists to disk across a restart but this in-memory
   * state doesn't, so treating "no record" as "caught up" would silently lie), or a genuine
   * buffer gap. Never advances the seq counter here, seq only advances on a real send.
   */
  resumeFor(deviceId: string, lastSeq: number | undefined): ResumeResult {
    const { out, isNew } = this.outboundFor(deviceId);
    this.log.touch(deviceId);

    if (lastSeq === undefined || isNew) {
      return { resume: null };
    }

    const { events, gap } = this.log.replayFrom(deviceId, out.current, lastSeq);
    return { resume: gap ? null : { events } };
  }

  /**
   * Advances this device's seq (creating its OutboundStream if this is the first time this
   * process has ever sent to it) and records the event for replay. Returns the seq assigned,
   * the caller uses it to seal the frame if the device is currently connected; if it's
   * offline, recording is all that happens, nothing to transmit to yet.
   */
  recordSent(deviceId: string, event: ServerEvent): number {
    const { out } = this.outboundFor(deviceId);
    const seq = out.next();
    const evicted = this.log.record(deviceId, seq, event);
    if (evicted) this.outbound.delete(evicted); // keep both maps' lifecycles in sync
    return seq;
  }

  /** Every device this process has sent to at least once, connected or not, broadcast()
   *  uses this to record events for currently-offline-but-known devices too. */
  knownDeviceIds(): string[] {
    return [...this.outbound.keys()];
  }

  /**
   * Accept-or-drop a client→daemon command seq for this device. `false` = already seen (a
   * resent duplicate, drop it, don't re-execute). Creates the device's InboundStream on first
   * use. Survives reconnect because it's keyed by deviceId, not connection.
   */
  acceptInbound(deviceId: string, seq: number): boolean {
    let s = this.inbound.get(deviceId);
    if (!s) {
      s = new InboundStream();
      this.inbound.set(deviceId, s);
    }
    return s.accept(seq);
  }

  /** Highest client→daemon seq ACCEPTED for this device (0 if none). Accepted is not processed. */
  inboundLastSeq(deviceId: string): number {
    return this.inbound.get(deviceId)?.lastSeq ?? 0;
  }

  /**
   * Record that a command was handled SUCCESSFULLY.
   *
   * Kept separate from acceptInbound because the two answer different questions: accepted means
   * "not a duplicate, so we ran it", processed means "and it actually worked". Conflating them let
   * the daemon acknowledge a command whose handler had thrown.
   */
  markProcessed(deviceId: string, seq: number): void {
    let p = this.processed.get(deviceId);
    if (!p) {
      p = { through: 0, ahead: new Set<number>() };
      this.processed.set(deviceId, p);
    }
    if (seq === p.through + 1) {
      p.through = seq;
      // A success can close a gap left by earlier out-of-order arrivals.
      while (p.ahead.delete(p.through + 1)) p.through++;
    } else if (seq > p.through) {
      p.ahead.add(seq);
    }
  }

  /**
   * The cumulative ack level: the highest seq such that EVERY seq up to it was processed
   * successfully.
   *
   * Contiguous on purpose. An ack is cumulative, so reporting a high-water mark would let command 6
   * succeeding implicitly confirm command 5 that failed, the client would drop 5 from its resend
   * buffer and report success for something that never happened. Stalling the level at the failure
   * means the client never sees a false confirmation: it keeps retrying and eventually surfaces an
   * honest error instead.
   */
  ackLevel(deviceId: string): number {
    return this.processed.get(deviceId)?.through ?? 0;
  }

  /** Called from index.ts's disconnectDevice() on `revoke`, clears all per-device state. */
  evict(deviceId: string) {
    this.outbound.delete(deviceId);
    this.inbound.delete(deviceId);
    this.processed.delete(deviceId);
    this.log.evict(deviceId);
  }
}
