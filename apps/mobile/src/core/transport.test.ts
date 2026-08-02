// The WebSocket transport glue (readyState send-guard, and the close teardown that must both tell the
// controller it disconnected and notify the caller) is exercised here against a fake WebSocket. The
// ClientController itself is tested separately over a fake transport; this proves the wiring around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWebSocket } from './transport.ts';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((e: any) => void)[]> = {};
  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  addEventListener(type: string, cb: (e: any) => void) { (this.handlers[type] ??= []).push(cb); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  fire(type: string, e?: any) { for (const cb of this.handlers[type] ?? []) cb(e); }
}

const opts = () => ({ deviceId: 'dev-1', crypto: {} as any, nextSeq: () => 1, onEvent: () => {} });

function withFakeWebSocket<T>(fn: () => T): T {
  const prev = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = FakeWebSocket as any;
  FakeWebSocket.instances = [];
  try { return fn(); } finally { (globalThis as any).WebSocket = prev; }
}

test('on open the controller connects and its plaintext hello is written', () => {
  withFakeWebSocket(() => {
    openWebSocket('ws://x', opts());
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.fire('open');
    assert.ok(ws.sent.length >= 1, 'the hello was written on connect');
    const hello = JSON.parse(ws.sent[0]);
    assert.equal(hello.type, 'hello');
    assert.equal(hello.deviceId, 'dev-1');
  });
});

test('a write while the socket is not OPEN is suppressed (no throw on a closing socket)', () => {
  withFakeWebSocket(() => {
    openWebSocket('ws://x', opts());
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.CONNECTING; // event fires but the socket is not open yet
    ws.fire('open');
    assert.equal(ws.sent.length, 0, 'nothing is written while readyState is not OPEN');
  });
});

test('close notifies the caller via onClose', () => {
  withFakeWebSocket(() => {
    let closed = false;
    openWebSocket('ws://x', opts(), () => { closed = true; });
    FakeWebSocket.instances.at(-1)!.fire('close');
    assert.ok(closed, 'onClose was invoked on socket close');
  });
});

test('close() from the caller closes the underlying socket', () => {
  withFakeWebSocket(() => {
    const conn = openWebSocket('ws://x', opts());
    conn.close();
    assert.ok(FakeWebSocket.instances.at(-1)!.closed, 'the socket was closed');
  });
});
