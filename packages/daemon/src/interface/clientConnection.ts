import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { open, seal } from '@claude-code-remote/protocol/node';
import type { ClientCommand, ServerEvent, UnauthClientMessage } from '@claude-code-remote/protocol';
import type { DeviceSessionRegistry } from '../domain/deviceSessions.ts';
import type { Logger, PairingService } from '../application/ports.ts';
import type { ClientConn, ClientHub } from './clientHub.ts';
import { guardMessage } from './messageGuard.ts';

export interface ClientConnectionDeps {
  hub: ClientHub;
  identity: PairingService;
  deviceSessions: DeviceSessionRegistry;
  maxPairedDevices: number;
  /**
   * Whether trust may be BOOTSTRAPPED on this listener. True for the local Unix socket, false for
   * the network listener.
   *
   * The whole pairing model rests on the one-time secret reaching the phone out of band, shown on
   * this machine's screen, read by its camera. `begin_pair` returns that secret to its caller, so
   * serving it on a network listener made pairing self-service: anything that could reach the port
   * could mint a secret, compute the proof itself, and become a trusted device, which grants spawn
   * and approve, i.e. code execution here. Reachability is not authorisation.
   */
  allowPairingBootstrap: boolean;
  /** Today's full snapshot, as events, for a client that cannot resume. */
  snapshot: () => ServerEvent[];
  /** Whichever client-facing address is genuinely live right now, read late, because the TCP
   *  listener may start after this handler is built and change the answer. */
  advertisedAddress: () => string;
  handleCommand: (cmd: ClientCommand, sock: net.Socket, deviceId: string) => void;
  log: Logger;
}

/**
 * The client protocol adapter: pairing handshake, frame authentication, inbound dedup, and acks.
 *
 * Pairing is plaintext by necessity (that is how trust is first established); every command after
 * `hello` is a SealedFrame. A socket the hub does not recognise is unauthenticated and can only
 * pair or say hello.
 *
 * This is the daemon's entire trust boundary, which is exactly why it is now one named module
 * rather than three closures beside the process lifecycle: the ordering rules below are
 * security-relevant and each one is load-bearing.
 */
/**
 * Largest single line accepted before a newline arrives.
 *
 * The read loop accumulates into `buf` and only drains on '\n', so without a cap a peer that
 * simply never sends one grows daemon memory until the process dies, measured at ~1.9 GB peak
 * from 120 MB of newline-free input, from an UNAUTHENTICATED connection. Two caps, because the two
 * states have wildly different legitimate needs: pairing and hello messages are a few hundred
 * bytes, while an authenticated `send` legitimately carries pasted context (measured to 258 KB,
 * larger once sealed and base64-encoded).
 */
const MAX_LINE_UNAUTHENTICATED = 64 * 1024;
const MAX_LINE_AUTHENTICATED = 4 * 1024 * 1024;

export function createClientConnectionHandler(deps: ClientConnectionDeps): (sock: net.Socket) => void {
  const {
    hub, identity, deviceSessions, maxPairedDevices, allowPairingBootstrap,
    snapshot, advertisedAddress, handleCommand, log,
  } = deps;

  function handleUnauth(sock: net.Socket, msg: UnauthClientMessage | any): void {
    switch (msg?.type) {
      case 'begin_pair': {
        // Refused on the network listener: handing the secret to the peer being authenticated,
        // over the very channel it authenticates, defeats the out-of-band property the QR flow
        // depends on. Pairing starts on the machine running the daemon; the phone still completes
        // it from anywhere.
        if (!allowPairingBootstrap) {
          log('pairing rejected: begin_pair is local-only and this connection arrived over the network');
          return hub.writeRaw(sock, { type: 'pair_failed' });
        }
        const p = identity.beginPairing(advertisedAddress());
        return hub.writeRaw(sock, { type: 'pair_qr', qr: p.qr, expiresAt: p.expiresAt });
      }

      case 'complete_pair': {
        // Checked before touching the one-time secret at all: an operational cap has nothing to
        // do with whether this proof is valid, so a legitimate phone shouldn't burn its secret on
        // a failure it can retry (e.g. after the operator revokes another device to free a slot).
        if (identity.pairedCount() >= maxPairedDevices) {
          log(`pairing rejected: at device cap (${maxPairedDevices} devices already paired)`);
          return hub.writeRaw(sock, { type: 'pair_failed' });
        }
        const result = identity.completePairing(msg.devicePublicKey, msg.deviceName ?? 'device', msg.proof);
        if (!result.ok) {
          // Logged with the reason, answered without it: the operator needs to know why a phone
          // would not pair; a caller probing the endpoint does not.
          log(`pairing rejected: ${result.reason}`);
          return hub.writeRaw(sock, { type: 'pair_failed' });
        }
        const device = result.device;
        log(`paired device ${device.deviceId} (${device.name})`);
        return hub.writeRaw(sock, { type: 'paired', deviceId: device.deviceId, daemonPublicKey: identity.publicKeyB64 });
      }

      case 'hello': {
        const device = identity.find(msg.deviceId);
        if (!device) {
          log(`hello rejected: unknown deviceId ${msg.deviceId}`);
          hub.writeRaw(sock, { type: 'hello_failed' });
          return void sock.destroy();
        }
        const salt = randomBytes(32);
        // The daemon's private key never reaches this layer: the service derives and returns
        // only the session key.
        const key = identity.deriveSessionKey(device.publicKey, salt);

        // Never trust a pre-auth field blindly: lastSeq must be a real non-negative integer or
        // it's treated as absent (forces a full resync, same as a first-ever hello).
        const lastSeq = Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : undefined;
        const { resume } = deviceSessions.resumeFor(device.deviceId, lastSeq);

        const conn: ClientConn = { key, deviceId: device.deviceId };
        hub.authenticate(sock, conn);

        if (resume) {
          hub.writeRaw(sock, {
            type: 'session_salt', salt: salt.toString('base64'),
            resumed: true, replayedCount: resume.events.length,
          });
          for (const { seq, event } of resume.events) {
            // Reuse the ORIGINAL seq, never draw a new one here, that would desync the client's
            // own count. Sealed directly rather than via sendSealed for exactly that reason.
            hub.writeRaw(sock, seal(conn.key, seq, event, 'd2c'));
          }
          log(`resumed device ${device.deviceId}: replayed ${resume.events.length} event(s)`);
        } else {
          hub.writeRaw(sock, { type: 'session_salt', salt: salt.toString('base64'), resumed: false });
          for (const ev of snapshot()) hub.sendSealed(sock, conn, ev);
        }

        // Command-redelivery ack, emitted LAST (after all resume/resync frames) so its higher seq
        // can't let the client's lastSeq leapfrog the replayed events. Only if we've actually
        // processed commands from this device, a first-ever/post-restart hello or a pure viewer
        // gets zero ack frames, so the forward-direction path is untouched. This proactively
        // drains commands processed-but-not-acked before the drop (a deduped resend runs no
        // handleCommand, so it emits no steady-state ack, this is what closes that hole).
        const ackTo = deviceSessions.ackLevel(device.deviceId);
        if (ackTo > 0) hub.sendSealed(sock, conn, { type: 'ack', upTo: ackTo });
        return;
      }

      default:
        // Any command before authentication is a protocol violation, not a plaintext fallback.
        log(`closing unauthenticated connection: unexpected message type=${msg?.type}`);
        return void sock.destroy();
    }
  }

  return function handleClientConnection(sock: net.Socket): void {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');

      // Checked BEFORE parsing: an oversized line is not a protocol error to answer, it is a peer
      // consuming memory, so the connection goes away rather than being politely rejected.
      const cap = hub.isAuthenticated(sock) ? MAX_LINE_AUTHENTICATED : MAX_LINE_UNAUTHENTICATED;
      if (buf.length > cap) {
        log(`closing connection: ${buf.length} bytes buffered with no newline (cap ${cap})`);
        buf = '';
        hub.forget(sock);
        sock.destroy();
        return;
      }

      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }

        const conn = hub.connFor(sock);
        if (!conn) { guardMessage(log, 'handling a pre-auth message', () => handleUnauth(sock, msg)); continue; }

        if (typeof msg.seq !== 'number') continue; // malformed
        let cmd: ClientCommand;
        try {
          // Client→daemon direction. A daemon→client frame reflected back here fails to open, so a
          // relay cannot bounce a sealed daemon event at the daemon and have it authenticate.
          cmd = open(conn.key, msg, 'c2d');
        } catch {
          log(`closing connection ${conn.deviceId}: frame failed to authenticate (tamper, wrong key, or reflected)`);
          hub.forget(sock);
          sock.destroy();
          continue;
        }

        // Dedup AFTER authenticating (open() has msg.seq as GCM AAD, so a genuine frame's seq is
        // authentic): only frames from the real paired device advance the persistent per-device
        // dedup watermark, so a garbage/tampered frame can't poison it. A duplicate seq here is a
        // resend of an already-processed command, drop it, don't re-execute. The client learns it
        // was received via the post-hello ack on the reconnect that triggered the resend.
        if (!deviceSessions.acceptInbound(conn.deviceId, msg.seq)) continue;
        // Guarded: a command handler that throws (a failed durable write, a malformed payload the
        // dispatcher didn't anticipate) must not terminate the daemon and every other session with it.
        const handled = guardMessage(log, `handling ${cmd?.type ?? 'a command'} from ${conn.deviceId}`,
          () => handleCommand(cmd, sock, conn.deviceId));
        // Only a command that actually ran advances the ack level. The dedup watermark is NOT
        // rolled back on failure, deliberately: a handler that threw may already have applied part
        // of its effect, and re-running it could duplicate that (a half-spawned session). Losing
        // the command while telling the client the truth beats executing it twice.
        if (handled) deviceSessions.markProcessed(conn.deviceId, msg.seq);

        // Steady-state cumulative ack. Guarded on the socket still being authenticated: a
        // revoke-self destroys its own socket (and evicts the device) inside handleCommand, so
        // acking afterward would be wrong.
        if (hub.isAuthenticated(sock)) {
          const upTo = deviceSessions.ackLevel(conn.deviceId);
          if (upTo > 0) hub.sendSealed(sock, conn, { type: 'ack', upTo });
        }
      }
    });

    sock.on('close', () => hub.forget(sock));
    sock.on('error', () => hub.forget(sock));
  };
}
