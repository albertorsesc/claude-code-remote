/**
 * Newline framing of a byte stream into messages, the host-side concern the ReliableClient docstring
 * calls out. It was hand-rolled identically in the CLI (four times), the daemon (session stdout, the
 * hook bridge, the client connection), each accumulating a buffer, draining on every '\n', skipping
 * blank lines, and, at the network boundary, dropping a peer that streams too many bytes with no
 * newline (an unbounded-buffer memory-exhaustion path). This is that mechanism, written once.
 *
 * It is pure and sans-IO: `push` raw chunks in, complete non-blank lines come out through `onLine`;
 * the caller owns the transport (what to do on overflow, how to parse each line). Portable, so the
 * kernel, the CLI, and the app can all share it.
 */
export interface LineFramerOptions {
  /** Called once per complete, non-blank line (the trailing '\n' stripped). */
  onLine: (line: string) => void;
  /**
   * Max bytes allowed to accumulate without a completing newline before the peer is dropped. A number
   * for a fixed cap, or a function for a state-dependent one (for example an auth-vs-unauth cap).
   * Omit entirely for a trusted local stream that needs no cap.
   */
  maxBytes?: number | (() => number);
  /** Invoked when `maxBytes` is exceeded, after the buffer is cleared. The caller tears down its
   *  transport (a network peer is consuming memory, not sending a protocol error to answer). */
  onOverflow?: (bufferedBytes: number, cap: number) => void;
}

export class LineFramer {
  private buf = '';
  private readonly opts: LineFramerOptions;

  constructor(opts: LineFramerOptions) {
    this.opts = opts;
  }

  /** Feed a chunk of the stream. Emits each complete non-blank line via `onLine`, in order. */
  push(chunk: string): void {
    this.buf += chunk;

    const { maxBytes } = this.opts;
    if (maxBytes !== undefined) {
      const cap = typeof maxBytes === 'function' ? maxBytes() : maxBytes;
      // Checked BEFORE draining: an oversized buffer is a peer consuming memory, not a line to parse.
      if (this.buf.length > cap) {
        const buffered = this.buf.length;
        this.buf = '';
        this.opts.onOverflow?.(buffered, cap);
        return;
      }
    }

    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.opts.onLine(line);
    }
  }

  /** Discard any buffered partial line (on disconnect, so a reconnect starts clean). */
  reset(): void {
    this.buf = '';
  }
}
