// The hand-written WebSocket transport (RFC 6455) is verified with Node's own built-in WebSocket
// client on the other end: the client masks its frames (as the spec requires of clients) and parses
// the server's unmasked frames, so a real interop partner exercises the handshake, the unmask path,
// and all three payload-length encodings (7-bit, 16-bit, 64-bit). The daemon's connection handler is
// unchanged and already tested over TCP; this proves the bytes reach it intact over WebSocket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createWebSocketServer } from '../src/interface/wsServer.ts';

/** Start an echo server: each message the shim delivers is written straight back, prefixed. */
async function startEcho() {
  const server = createWebSocketServer({
    host: '127.0.0.1', port: 0, log: () => {},
    onConnection: (sock: net.Socket) => {
      sock.on('data', (chunk: Buffer) => sock.write('echo:' + chunk.toString('utf8')));
    },
  });
  await once(server, 'listening');
  const port = (server.address() as any).port;
  return { server, url: `ws://127.0.0.1:${port}` };
}

async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

/** Send `msg` and resolve with the next message the server sends back. */
function roundTrip(ws: WebSocket, msg: string): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(String((e as MessageEvent).data)), { once: true });
    ws.send(msg);
  });
}

/** Do the WebSocket handshake by hand over a raw socket, for tests that must send crafted frames a
 *  compliant client would never produce. Resolves once the server's 101 response has arrived. */
async function rawHandshake(port: number): Promise<net.Socket> {
  const sock = net.connect(port, '127.0.0.1');
  await once(sock, 'connect');
  const key = randomBytes(16).toString('base64');
  sock.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await new Promise<void>((resolve, reject) => {
    let acc = '';
    const onData = (c: Buffer) => {
      acc += c.toString('latin1');
      if (acc.includes('\r\n\r\n')) { sock.off('data', onData); resolve(); }
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
  return sock;
}

test('handshake + echo round-trips across all payload-length encodings', async () => {
  const { server, url } = await startEcho();
  const ws = await open(url);
  for (const len of [5, 200, 70000]) { // 7-bit, 16-bit, and 64-bit length frames
    const msg = 'x'.repeat(len);
    assert.equal(await roundTrip(ws, msg), 'echo:' + msg, `length ${len} round-trips intact`);
  }
  ws.close();
  server.close();
});

test('several messages in quick succession stay correctly framed', async () => {
  const { server, url } = await startEcho();
  const ws = await open(url);
  const got: string[] = [];
  ws.addEventListener('message', (e) => got.push(String((e as MessageEvent).data)));
  for (const m of ['one', 'two', 'three', 'four']) ws.send(m);
  // Wait until all four echoes are back.
  await new Promise<void>((r) => {
    const timer = setInterval(() => { if (got.length >= 4) { clearInterval(timer); r(); } }, 5);
  });
  assert.deepEqual(got.sort(), ['echo:four', 'echo:one', 'echo:three', 'echo:two']);
  ws.close();
  server.close();
});

test('the shim reports close when the client disconnects', async () => {
  let closed = false;
  const server = createWebSocketServer({
    host: '127.0.0.1', port: 0, log: () => {},
    onConnection: (sock: net.Socket) => { sock.on('close', () => { closed = true; }); },
  });
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const ws = await open(`ws://127.0.0.1:${port}`);
  ws.close();
  await new Promise<void>((r) => {
    const timer = setInterval(() => { if (closed) { clearInterval(timer); r(); } }, 5);
  });
  assert.ok(closed, 'the connection handler saw the socket close');
  server.close();
});

test('a plain HTTP request to the WebSocket port is refused, not upgraded', async () => {
  const server = createWebSocketServer({ host: '127.0.0.1', port: 0, log: () => {}, onConnection: () => {} });
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 426, 'a non-WebSocket request gets 426 Upgrade Required');
  server.close();
});

test('a frame declaring an oversized length is dropped before its payload is buffered', async () => {
  // A compliant client cannot lie about a frame length, so this test speaks raw bytes: it does the
  // WebSocket handshake by hand, then sends a masked binary frame whose 64-bit length header declares
  // far more than the 8 MiB cap while sending only a few bytes. The server must close the connection
  // on the header alone, never accumulating the declared payload (the OOM path this guards against).
  let dataSeen = 0;
  const server = createWebSocketServer({
    host: '127.0.0.1', port: 0, log: () => {},
    onConnection: (sock: net.Socket) => { sock.on('data', (c: Buffer) => { dataSeen += c.length; }); },
  });
  await once(server, 'listening');
  const port = (server.address() as any).port;

  const sock = await rawHandshake(port);

  // Masked binary frame, FIN set, 64-bit length = cap + 1, but only 4 payload bytes actually sent.
  const header = Buffer.alloc(2 + 8 + 4);
  header[0] = 0x82; // FIN + binary
  header[1] = 0x80 | 127; // masked + 64-bit length follows
  header.writeBigUInt64BE(BigInt(8 * 1024 * 1024 + 1), 2);
  const mask = randomBytes(4);
  mask.copy(header, 10);
  const closed = once(sock, 'close');
  sock.write(Buffer.concat([header, Buffer.from([0, 0, 0, 0])]));

  await closed; // the server dropped us on the header; no hang, no growth
  assert.equal(dataSeen, 0, 'no message bytes were ever delivered upstream');
  server.close();
});

test('an unmasked client frame is rejected (RFC 6455 requires client frames be masked)', async () => {
  let dataSeen = 0;
  const server = createWebSocketServer({
    host: '127.0.0.1', port: 0, log: () => {},
    onConnection: (sock: net.Socket) => { sock.on('data', (c: Buffer) => { dataSeen += c.length; }); },
  });
  await once(server, 'listening');
  const port = (server.address() as any).port;

  const sock = await rawHandshake(port);
  const closed = once(sock, 'close');
  // FIN + binary, mask bit clear, 3-byte payload: a compliant client always masks, so this must drop.
  sock.write(Buffer.from([0x82, 0x03, 1, 2, 3]));

  await closed;
  assert.equal(dataSeen, 0, 'the unmasked frame was never delivered upstream');
  server.close();
});
