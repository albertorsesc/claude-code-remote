// The hand-written WebSocket transport (RFC 6455) is verified with Node's own built-in WebSocket
// client on the other end: the client masks its frames (as the spec requires of clients) and parses
// the server's unmasked frames, so a real interop partner exercises the handshake, the unmask path,
// and all three payload-length encodings (7-bit, 16-bit, 64-bit). The daemon's connection handler is
// unchanged and already tested over TCP; this proves the bytes reach it intact over WebSocket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type net from 'node:net';
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
