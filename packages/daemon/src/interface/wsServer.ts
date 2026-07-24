/**
 * A self-contained, zero-dependency WebSocket listener, added so an Expo Go phone (whose only socket
 * is a WebSocket) can reach the daemon. It is a pure transport bridge and DELIBERATELY isolated: it
 * imports nothing from the rest of the daemon except the `Logger` type, and it does not change the
 * client protocol at all. Each WebSocket connection is presented to the EXISTING, unchanged
 * `createClientConnectionHandler` as a `net.Socket`-shaped shim, so pairing, frame authentication,
 * dedup, acks, and the crypto are reused verbatim.
 *
 * Every WebSocket text message carries exactly one newline-terminated protocol frame, the same bytes
 * the raw-TCP listener carries, so both the daemon's handler and the app's client keep their existing
 * newline framing and neither needs a WebSocket-specific code path.
 *
 * The WebSocket wire format (RFC 6455) is implemented here by hand, node:crypto for the handshake
 * accept key and a small frame parser/encoder, in the same "no dependency, we own it" spirit as the
 * rest of the daemon (the QR encoder, the crypto). ws:// only; TLS is not this layer's job (the
 * payload is already end-to-end encrypted and the transport rides a Tailscale tailnet).
 */
import http from 'node:http';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from '../application/ports.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Cap on a single (possibly fragmented) message the shim will assemble, before it drops the peer. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Build a server->client text frame: FIN + opcode 0x1, unmasked (server frames are never masked). */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const CLOSE_FRAME = Buffer.from([0x88, 0x00]);
function pongFrame(payload: Buffer): Buffer {
  // Control frames carry <= 125 bytes; a compliant ping never exceeds that.
  return Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
}

/**
 * Presents an upgraded socket carrying WebSocket frames as the small `net.Socket` surface the client
 * connection handler and the hub actually use: `on('data'|'close'|'error')`, `write(string)`,
 * `writableLength`, and `destroy()`. It is cast to `net.Socket` at the one call site below, so the
 * handler stays typed against the real socket and unaware this shim exists.
 */
class WsSocketShim extends EventEmitter {
  private raw: Duplex;
  private buf = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragBytes = 0;
  private destroyed = false;

  constructor(raw: Duplex) {
    super();
    this.raw = raw;
    raw.on('data', (chunk: Buffer) => this.onBytes(chunk));
    raw.on('close', () => this.emit('close'));
    raw.on('error', (e: Error) => this.emit('error', e));
  }

  get writableLength(): number {
    return this.raw.writableLength;
  }

  write(data: string): boolean {
    if (this.destroyed) return false;
    return this.raw.write(encodeTextFrame(data));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.raw.write(CLOSE_FRAME); } catch { /* peer already gone */ }
    this.raw.destroy();
  }

  private onBytes(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Parse as many complete frames as the buffer currently holds.
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      let mask: Buffer | null = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        mask = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return; // whole frame not here yet

      let payload = this.buf.subarray(offset, offset + len);
      if (mask) {
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      }
      this.buf = this.buf.subarray(offset + len);

      switch (opcode) {
        case 0x8: // close
          this.destroy();
          return;
        case 0x9: // ping -> pong
          try { this.raw.write(pongFrame(payload)); } catch { /* gone */ }
          break;
        case 0xa: // pong -> ignore
          break;
        case 0x0: // continuation
        case 0x1: // text
        case 0x2: { // binary (treated as a message; the payload is JSON either way)
          this.frags.push(payload);
          this.fragBytes += payload.length;
          if (this.fragBytes > MAX_MESSAGE_BYTES) { this.destroy(); return; }
          if (fin) {
            const message = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags);
            this.frags = [];
            this.fragBytes = 0;
            this.emit('data', message); // one newline-terminated protocol frame, as the handler expects
          }
          break;
        }
        default:
          this.destroy();
          return;
      }
    }
  }
}

export interface WebSocketServerDeps {
  host: string;
  port: number;
  /** The SAME handler the raw-TCP listener uses; the shim is passed to it as a socket. */
  onConnection: (sock: net.Socket) => void;
  log: Logger;
}

/**
 * Start a WebSocket listener that hands each connection to `onConnection`. Returns the http.Server so
 * the composition root can log its `listening` event, exactly like the TCP listener.
 */
export function createWebSocketServer(deps: WebSocketServerDeps): http.Server {
  const server = http.createServer((_req, res) => {
    // A plain HTTP request is not what this port is for.
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This endpoint speaks WebSocket only.\n');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const shim = new WsSocketShim(socket);
    // The handler only uses the net.Socket subset the shim implements; cast at this one boundary so
    // the handler and hub stay typed against the real socket and unchanged.
    deps.onConnection(shim as unknown as net.Socket);
  });

  server.on('error', (err) => deps.log(`WebSocket listener error: ${err.message}`));
  server.listen(deps.port, deps.host);
  return server;
}
