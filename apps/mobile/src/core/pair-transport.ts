/**
 * The one network step of pairing: send the `complete_pair` message to the daemon and wait for its
 * `paired` reply. Pairing happens BEFORE a session key exists, so this is a raw, unencrypted, one-shot
 * WebSocket exchange, deliberately separate from the long-lived session transport (transport.ts).
 *
 * Framing mirrors the rest of the protocol: newline-delimited JSON. It opens the socket, writes one
 * framed line, reads until it sees `paired` (resolve) or `pair_failed` (reject), then closes. A
 * timeout guards against a daemon that never answers. Dependency-free by design: it uses only the
 * global WebSocket, so it runs in Expo Go and is testable in Node with a fake WebSocket.
 */
import type { UnauthServerMessage } from '@claude-code-remote/protocol';

/** The `complete_pair` message minted by `startPairing` in the pairing flow. */
export interface PairCompleteMessage {
  type: 'complete_pair';
  devicePublicKey: string;
  deviceName: string;
  proof: string;
}

/** What the daemon returns on success. The daemon public key is echoed but the record takes it from
 *  the authenticated pairing payload, not from this reply. */
export interface PairedResult {
  deviceId: string;
  daemonPublicKey: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Open a raw WebSocket to `target`, send the `complete_pair` line, and resolve with the daemon's
 * `paired` reply. Rejects on `pair_failed`, on socket error or early close, or after `timeoutMs`.
 * The socket is always closed before settling.
 */
export function completePairOverWebSocket(
  target: string,
  completePair: PairCompleteMessage,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PairedResult> {
  return new Promise<PairedResult>((resolve, reject) => {
    const socket = new WebSocket(target);
    let settled = false;
    let buffer = '';

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Pairing timed out. Is the daemon reachable on your tailnet?')));
    }, timeoutMs);

    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closing; the settle below is what matters.
      }
      settle();
    }

    socket.addEventListener('open', () => {
      socket.send(`${JSON.stringify(completePair)}\n`);
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      buffer += typeof event.data === 'string' ? event.data : String(event.data);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: UnauthServerMessage;
        try {
          message = JSON.parse(line) as UnauthServerMessage;
        } catch {
          continue; // a malformed line is dropped, not fatal
        }
        if (message.type === 'paired') {
          finish(() => resolve({ deviceId: message.deviceId, daemonPublicKey: message.daemonPublicKey }));
          return;
        }
        if (message.type === 'pair_failed') {
          finish(() => reject(new Error('The daemon rejected pairing. The code may have expired, so scan a fresh one.')));
          return;
        }
      }
    });

    socket.addEventListener('error', () => {
      finish(() => reject(new Error('Could not reach the daemon to pair.')));
    });

    socket.addEventListener('close', () => {
      finish(() => reject(new Error('The pairing connection closed before it completed.')));
    });
  });
}
