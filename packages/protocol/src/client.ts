/**
 * The client-side reliable-delivery state machine, shared by every client of the daemon: the CLI
 * today and the React Native app next. It is the mirror of the daemon's reconnect-replay + inbound
 * dedup, and it is the subtle, security-critical part of a client, so it lives here, in the portable
 * kernel, written once and tested once, rather than being reimplemented (and re-broken) per platform.
 *
 * Sans-IO by design: it owns NO socket, NO timer, NO crypto implementation, and NO rendering. It is a
 * pure state machine that the host drives with four inputs (onOpen / onMessage / send / onClose),
 * pulls outbound frames from with drain(), and observes through callbacks (onReady / onEvent / onAck /
 * onHelloRejected). This keeps it free of `node:*` (so React Native imports it unchanged) and makes
 * the reliability invariants unit-testable against a fake crypto, with zero sockets or clocks.
 *
 * What the HOST still owns, because it is platform-specific:
 *   - the transport (Unix socket / node:net for the CLI; react-native-tcp-socket for the app),
 *   - newline framing of the byte stream into messages,
 *   - the reconnect timer + backoff policy (a phone reconnects on foreground; the CLI on a fixed
 *     schedule, there is no single correct policy, so the engine does not impose one),
 *   - the crypto IMPLEMENTATION, wrapped as a SessionCrypto (node:crypto vs pure-JS @noble),
 *   - the outbound seq source (a cross-process file lock for the CLI; an in-memory counter for the
 *     single-process app), injected as nextSeq,
 *   - what a rendered event / ack / rejection MEANS (print + exit for the one-shot CLI; update a store
 *     for the streaming app), all of that is the host's reaction in the callbacks.
 */

import { InboundStream } from './sync.ts';
import { ResendBuffer } from './resend.ts';
import type { ServerEvent } from './types.ts';
import type { SealedFrame, Direction } from './frame.ts';

/** An opaque session-key handle. The engine never inspects it; only the SessionCrypto that made it does. */
export type SessionKey = unknown;

/**
 * The crypto operations the engine needs, with the key material and byte encoding hidden inside the
 * implementation. `deriveKey` takes the daemon's base64 salt verbatim so all Buffer/Uint8Array
 * handling stays in the platform impl and the engine stays byte-free (hence portable).
 */
export interface SessionCrypto {
  /** Derive the per-connection session key from the daemon's `session_salt` (base64, as sent). */
  deriveKey(saltB64: string): SessionKey;
  seal(key: SessionKey, seq: number, plaintext: unknown, direction: Direction): SealedFrame;
  /** @throws if the frame fails authentication (tampered, wrong key, or wrong direction). */
  open(key: SessionKey, frame: SealedFrame, direction: Direction): unknown;
}

/** A message the host must JSON-stringify, newline-frame, and write to the socket. */
export type Outbound = { type: 'hello'; deviceId: string; lastSeq?: number } | SealedFrame;

export interface ReliableClientHandlers {
  /**
   * Fired when the handshake completes and the session key is live, after any unacked write commands
   * have already been queued for resend, so a `send()` made from inside this callback is ordered after
   * them. `resumed: false` means the daemon resynced from scratch (it restarted), and the inbound
   * checkpoint has just been reset; the host typically (re)issues its read/write command here.
   */
  onReady?(info: { resumed: boolean; replayedCount: number }): void;
  /** An authenticated, deduplicated, non-ack event. The host renders it / updates its state. */
  onEvent(event: ServerEvent, seq: number): void;
  /** The cumulative ack advanced: the daemon has processed every client→daemon command up to `upTo`. */
  onAck?(upTo: number): void;
  /** The daemon did not recognize this device (fresh daemon identity, wrong daemon, or revoked). */
  onHelloRejected?(): void;
  /** A frame arrived that failed to authenticate and was dropped. Diagnostic only. */
  onAuthError?(): void;
}

export interface ReliableClientOptions extends ReliableClientHandlers {
  deviceId: string;
  crypto: SessionCrypto;
  /** Reserve the next outbound seq. Must be monotonic per device across everything that shares the
   *  daemon's per-device dedup space (for the CLI, across concurrent processes, hence a file lock). */
  nextSeq(): number;
}

/** Thrown by send() when a reliable command cannot be buffered because the resend buffer is full.
 *  The host must hard-fail (never silently drop a control-plane command the operator issued). */
export class ResendOverflowError extends Error {
  constructor() {
    super('resend buffer full, too many un-acknowledged commands (daemon unreachable)');
    this.name = 'ResendOverflowError';
  }
}

export class ReliableClient {
  private readonly deviceId: string;
  private readonly crypto: SessionCrypto;
  private readonly nextSeq: () => number;
  private readonly h: ReliableClientHandlers;

  // Persist across reconnects within one client lifetime, the whole point of reconnect-replay.
  // `inb` is REASSIGNED (not cleared in place) on a full resync; see onSessionSalt.
  private inb = new InboundStream();
  private readonly resend = new ResendBuffer();
  private maxAcked = 0;

  // Per-connection: the live session key, or null while disconnected / mid-handshake.
  private key: SessionKey | null = null;

  // Frames accumulated since the last drain(). The host writes them after each input call.
  private outbox: Outbound[] = [];

  constructor(opts: ReliableClientOptions) {
    this.deviceId = opts.deviceId;
    this.crypto = opts.crypto;
    this.nextSeq = opts.nextSeq;
    this.h = opts;
  }

  /** The socket just connected: queue the hello, asking to resume from our inbound checkpoint if any. */
  onOpen(): void {
    const hello: Outbound = { type: 'hello', deviceId: this.deviceId };
    if (this.inb.lastSeq > 0) hello.lastSeq = this.inb.lastSeq;
    this.outbox.push(hello);
  }

  /** Feed one decoded message (a parsed JSON line) from the socket. */
  onMessage(msg: unknown): void {
    const m = msg as { type?: string; seq?: unknown; salt?: string; resumed?: boolean; replayedCount?: number };

    if (this.key === null) {
      // Pre-key: only the plaintext handshake is meaningful. Anything else (including a stray sealed
      // frame before session_salt) is ignored, matching the CLI's original behavior.
      if (m.type === 'hello_failed') { this.h.onHelloRejected?.(); return; }
      if (m.type === 'session_salt') { this.onSessionSalt(m as { salt: string; resumed?: boolean; replayedCount?: number }); return; }
      return;
    }

    // Post-key: every frame is sealed. `seq` is the only plaintext field we read before authenticating.
    if (typeof m.seq !== 'number') return;
    let ev: ServerEvent;
    try {
      ev = this.crypto.open(this.key, msg as SealedFrame, 'd2c') as ServerEvent;
    } catch {
      // Authentication failed: tampered, sealed under a different key, or a d2c frame reflected as c2d.
      this.h.onAuthError?.();
      return;
    }

    // Dedup AFTER authenticating, the same rule the daemon uses, for the same reason: seq is plaintext
    // on the wire but bound into the AEAD as associated data, so only a genuine frame may advance this
    // watermark. Checking first would let an injected frame burn a seq and make the real event carrying
    // it look like a duplicate.
    if (!this.inb.accept(m.seq)) return;

    if (ev.type === 'ack') {
      this.maxAcked = Math.max(this.maxAcked, ev.upTo);
      this.resend.ackUpTo(ev.upTo);
      this.h.onAck?.(ev.upTo);
      return; // acks are transport control, never rendered
    }
    this.h.onEvent(ev, m.seq);
  }

  private onSessionSalt(m: { salt: string; resumed?: boolean; replayedCount?: number }): void {
    this.key = this.crypto.deriveKey(m.salt);
    if (!m.resumed) {
      // Full resync (the daemon restarted): its per-device seq now begins again at 1, so our old
      // watermark describes a sequence space that no longer exists. Keeping it would reject the entire
      // resync and everything after it as stale duplicates while the reconnect still reported success,
      // a client that looks healthy and renders nothing. Reset the stream to match the daemon's.
      this.inb = new InboundStream();
    }
    // Resend unacked writes FIRST, at their ORIGINAL seq, re-sealed under this new key (the daemon
    // dedups, so a resend is never a re-execution). Queuing them before onReady fires guarantees they
    // precede any fresh command the host issues from its onReady handler.
    for (const [seq, cmd] of this.resend.pending()) {
      this.outbox.push(this.crypto.seal(this.key, seq, cmd, 'c2d'));
    }
    this.h.onReady?.({ resumed: !!m.resumed, replayedCount: m.replayedCount ?? 0 });
  }

  /**
   * Enqueue a command to the daemon and return the seq it was assigned. `reliable` writes
   * (spawn/send/interrupt/decide/revoke/set_*) are buffered and auto-resent at this seq on every
   * reconnect until acked; non-reliable reads (history/list) are not buffered, the host reissues them
   * fresh on each onReady, because a deduped read yields no reply.
   *
   * A command sent while disconnected (no key): if reliable, it is buffered and goes out on the next
   * onReady via the resend loop; if non-reliable, it is dropped (the host reissues reads on connect).
   *
   * @throws ResendOverflowError if a reliable command cannot be buffered.
   */
  send(command: unknown, opts: { reliable: boolean }): number {
    const seq = this.nextSeq();
    if (opts.reliable && !this.resend.add(seq, command)) throw new ResendOverflowError();
    if (this.key !== null) this.outbox.push(this.crypto.seal(this.key, seq, command, 'c2d'));
    return seq;
  }

  /** The socket dropped. Forget the per-connection key; inb/resend/maxAcked persist for the reconnect. */
  onClose(): void {
    this.key = null;
  }

  /** Take the frames queued since the last call. The host JSON-stringifies + newline-frames + writes each. */
  drain(): Outbound[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** Highest seq the daemon has cumulatively acked. Lets a one-shot host know its write landed. */
  get lastAcked(): number {
    return this.maxAcked;
  }

  /** The inbound resume checkpoint (highest daemon seq accepted). Sent as hello.lastSeq on reconnect. */
  get resumeSeq(): number {
    return this.inb.lastSeq;
  }

  /** True once the handshake has produced a live session key on the current connection. */
  get ready(): boolean {
    return this.key !== null;
  }
}
