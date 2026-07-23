/**
 * The RN host for the shared `ReliableClient`, the mobile analogue of the CLI's cc.ts host. It owns
 * the newline framing and the drain/write plumbing, and is deliberately transport-agnostic: the real
 * `react-native-tcp-socket` adapter (and, in tests, a fake) call `connected()` / `feed()` /
 * `disconnected()` and supply a `write`, and the screens call `send()`. The reliability itself
 * (reconnect-replay, dedup, resend, acks) lives in the engine, not here.
 *
 * Reconnect/backoff is intentionally NOT built in: a phone reconnects on app foreground and network
 * regain, which is the transport layer's concern, so it drives `disconnected()` then `connected()`
 * when it sees fit. The engine's resume checkpoint and resend buffer survive across those calls.
 */
import { ReliableClient, type SessionCrypto, type ServerEvent } from '@claude-code-remote/protocol';

export interface ClientControllerOptions {
  deviceId: string;
  crypto: SessionCrypto;
  /** Monotonic outbound seq. In the app this is an in-memory counter seeded from secure storage. */
  nextSeq: () => number;
  /** How to write a framed line to the socket. */
  write: (line: string) => void;
  onEvent: (event: ServerEvent, seq: number) => void;
  onReady?: (info: { resumed: boolean; replayedCount: number }) => void;
  onAck?: (upTo: number) => void;
  onHelloRejected?: () => void;
}

export class ClientController {
  private readonly client: ReliableClient;
  private readonly write: (line: string) => void;
  private buf = '';

  constructor(opts: ClientControllerOptions) {
    this.write = opts.write;
    this.client = new ReliableClient({
      deviceId: opts.deviceId,
      crypto: opts.crypto,
      nextSeq: opts.nextSeq,
      onEvent: opts.onEvent,
      onReady: opts.onReady,
      onAck: opts.onAck,
      onHelloRejected: opts.onHelloRejected,
    });
  }

  private flush() {
    for (const o of this.client.drain()) this.write(JSON.stringify(o) + '\n');
  }

  /** The socket connected: send the hello (resuming from the engine's checkpoint if any). */
  connected() {
    this.client.onOpen();
    this.flush();
  }

  /** Feed raw bytes from the socket. Frames newline-delimited JSON and processes each message. */
  feed(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a malformed line is dropped, not fatal
      }
      this.client.onMessage(msg);
      this.flush();
    }
  }

  /** The socket dropped. The engine keeps its resume checkpoint and resend buffer for the reconnect. */
  disconnected() {
    this.client.onClose();
    this.buf = '';
  }

  /**
   * Enqueue a command. `reliable` (the default) buffers it for resend until acked, for writes like a
   * decision or a spawn; pass false for one-shot reads that are reissued fresh on reconnect.
   * @returns the assigned outbound seq.
   */
  send(command: unknown, reliable = true): number {
    const seq = this.client.send(command, { reliable });
    this.flush();
    return seq;
  }

  get ready(): boolean {
    return this.client.ready;
  }
}
