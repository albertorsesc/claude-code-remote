import type net from 'node:net';
import { seal } from '@claudecode/protocol/node';
import type { ServerEvent } from '@claudecode/protocol';
import type { DeviceSessionRegistry } from '../domain/deviceSessions.ts';
import type { Logger } from '../application/ports.ts';

/**
 * How much unsent data may queue for one client before it is dropped.
 *
 * sock.write() returns false once its buffer exceeds the high-water mark, and ignoring that means a
 * client which stops reading is absorbed by the DAEMON's memory instead of its own. A phone is
 * exactly that peer: backgrounded, out of signal, or in TCP zero-window. The connection stays open,
 * so nothing tears it down, and the daemon just keeps queueing, measured at +89 MB of RSS from
 * 7.2 MB of events aimed at a single non-reading client.
 *
 * Disconnecting is safe here, and cheap, precisely because reconnect-replay already exists: the
 * device's events keep accumulating in the bounded per-device replay log, and on reconnect the
 * client resumes from its lastSeq (or takes a full resync if it fell past the buffer). So the
 * backlog moves from an unbounded socket buffer into a bounded structure designed to hold it.
 */
const MAX_CLIENT_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * An authenticated client connection: just the per-connection crypto key + which device it is.
 * ALL per-device seq state (outbound replay AND inbound dedup) lives in the DeviceSessionRegistry,
 * keyed by deviceId, so it survives this specific connection closing, that is what makes
 * reconnect-replay and command redelivery work.
 */
export interface ClientConn {
  key: Buffer;
  deviceId: string;
}

/**
 * Owns the set of live authenticated client sockets and every sealed write that goes to them.
 *
 * Extracted from the entry point so that "who is connected" and "how an event becomes ciphertext
 * on a socket" live in one place with one set of rules, instead of being open-coded next to
 * process lifecycle and pairing. Everything else in the daemon publishes domain events and stays
 * unaware of sockets, keys, and sequence numbers entirely.
 */
export class ClientHub {
  private clients = new Map<net.Socket, ClientConn>();
  private deviceSessions: DeviceSessionRegistry;
  private log: Logger;

  // Explicit assignment, not a parameter property: Node's strip-only TypeScript mode rejects
  // parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) and this project runs .ts directly.
  constructor(deviceSessions: DeviceSessionRegistry, log: Logger) {
    this.deviceSessions = deviceSessions;
    this.log = log;
  }

  /** Promotes a socket from "still in the plaintext handshake" to authenticated. */
  authenticate(sock: net.Socket, conn: ClientConn): void {
    this.clients.set(sock, conn);
  }

  forget(sock: net.Socket): void {
    this.clients.delete(sock);
  }

  isAuthenticated(sock: net.Socket): boolean {
    return this.clients.has(sock);
  }

  connFor(sock: net.Socket): ClientConn | undefined {
    return this.clients.get(sock);
  }

  /** Assigns the device's next outbound seq, seals, and writes. For a single socket only, broadcast
   *  draws the seq once per device (see below), because a device can hold more than one socket. */
  sendSealed(sock: net.Socket, conn: ClientConn, ev: ServerEvent): void {
    const seq = this.deviceSessions.recordSent(conn.deviceId, ev);
    this.sealAndWrite(sock, conn, seq, ev);
  }

  /** Seals an already-assigned (seq, ev) under this socket's own key and writes it. Two sockets of
   *  the same device share the seq but each seals under its own per-connection key. Direction is
   *  always daemon→client here. */
  private sealAndWrite(sock: net.Socket, conn: ClientConn, seq: number, ev: ServerEvent): void {
    const frame = seal(conn.key, seq, ev, 'd2c');
    this.writeFrame(sock, frame);
  }

  /** Sends to a socket only if it is authenticated; a no-op otherwise. */
  sendTo(sock: net.Socket, ev: ServerEvent): void {
    const conn = this.clients.get(sock);
    if (conn) this.sendSealed(sock, conn, ev);
  }

  /**
   * Records this event for EVERY device the process has ever sent to, connected or not, an
   * offline device must keep accumulating replay history, or reconnect-replay has nothing to catch
   * up on (found by a failing integration test: broadcasting only to live sockets silently skipped
   * every disconnected device's buffer entirely). Actual ciphertext transmission still only happens
   * for currently-connected sockets.
   */
  broadcast(ev: ServerEvent): void {
    // One seq per DEVICE per event, not per socket. A device can hold more than one live connection
    // (the documented usage is `cc watch` in one shell and `cc allow`/`cc send` in another, both the
    // same device.json). Drawing a fresh seq per socket made one broadcast consume two seqs and
    // record the same event twice in that device's replay log, so each connection tracked a different
    // subset of the counter and a reconnect replayed events the peer had already rendered. Group the
    // sockets first (also snapshotting them, so a mid-write backlog-drop can't disturb iteration),
    // record the seq once per device, then seal that single (seq, ev) under each socket's own key.
    const socketsByDevice = new Map<string, Array<[net.Socket, ClientConn]>>();
    for (const [sock, conn] of this.clients) {
      const group = socketsByDevice.get(conn.deviceId);
      if (group) group.push([sock, conn]);
      else socketsByDevice.set(conn.deviceId, [[sock, conn]]);
    }
    for (const [deviceId, group] of socketsByDevice) {
      const seq = this.deviceSessions.recordSent(deviceId, ev);
      for (const [sock, conn] of group) this.sealAndWrite(sock, conn, seq, ev);
    }
    // Offline-but-known devices keep accumulating replay history (no socket to transmit to).
    for (const deviceId of this.deviceSessions.knownDeviceIds()) {
      if (!socketsByDevice.has(deviceId)) this.deviceSessions.recordSent(deviceId, ev);
    }
  }

  /**
   * Drops a device's replay/seq state and closes any socket it still holds. Called on revoke:
   * trust is gone, so the live connection must not outlive it.
   */
  disconnectDevice(deviceId: string): void {
    this.deviceSessions.evict(deviceId);
    for (const [sock, conn] of this.clients) {
      if (conn.deviceId === deviceId) {
        this.clients.delete(sock);
        sock.destroy();
      }
    }
  }

  /** Plaintext write, for the pairing handshake only, before any key exists to seal with. */
  writeRaw(sock: net.Socket, o: unknown): void {
    this.writeFrame(sock, o);
  }

  private writeFrame(sock: net.Socket, frame: unknown): void {
    try {
      sock.write(JSON.stringify(frame) + '\n');
      // Backpressure. write() already told us it was over the mark by returning false, but the
      // queued volume is what actually matters, and it is what an unresponsive client grows.
      if (sock.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
        const conn = this.clients.get(sock);
        this.log(`dropping ${conn?.deviceId ?? 'unauthenticated client'}: ${sock.writableLength} ` +
                 `bytes queued unsent (cap ${MAX_CLIENT_BACKLOG_BYTES}), it will resume from its ` +
                 `replay log when it reconnects`);
        this.clients.delete(sock);
        sock.destroy();
      }
    } catch {
      /* dropped client, the socket's own close/error handlers do the cleanup */
    }
  }
}
