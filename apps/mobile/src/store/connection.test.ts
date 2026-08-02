// The managed connection owns the phone's reconnect policy: open is idempotent, a foreground event
// reopens only when dropped and not user-closed, and a user disconnect must not reopen. With AppState
// injected as subscribeForeground, that policy is testable against a fake WebSocket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, exportPublic } from '@claude-code-remote/protocol/node';
import { startPairing, deviceRecordFromPaired } from '../core/protocol/pairing.ts';
import { createConnection, type ConnectionStatus } from './connection.ts';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private handlers: Record<string, ((e: any) => void)[]> = {};
  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  addEventListener(type: string, cb: (e: any) => void) { (this.handlers[type] ??= []).push(cb); }
  send() {}
  close() { this.fire('close'); }
  fire(type: string, e?: any) { for (const cb of this.handlers[type] ?? []) cb(e); }
}

function makeRecord() {
  const daemon = generateIdentity();
  const payload = { v: 1, addr: 'ws://127.0.0.1:7443', pk: exportPublic(daemon.publicKey), s: 'sekret' };
  return deviceRecordFromPaired('dev-1', startPairing(payload, 'phone'), payload);
}

function harness() {
  const statuses: ConnectionStatus[] = [];
  let foreground: (() => void) | null = null;
  let unsubscribed = false;
  const mc = createConnection(makeRecord(), {
    nextSeq: () => 1,
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
    subscribeForeground: (cb) => { foreground = cb; return () => { unsubscribed = true; }; },
  });
  return { mc, statuses, fireForeground: () => foreground?.(), wasUnsubscribed: () => unsubscribed };
}

function withFakeWebSocket(fn: () => void): void {
  const prev = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = FakeWebSocket as any;
  FakeWebSocket.instances = [];
  try { fn(); } finally { (globalThis as any).WebSocket = prev; }
}

test('connect() twice opens a single socket, and reports connecting', () => {
  withFakeWebSocket(() => {
    const { mc, statuses } = harness();
    mc.connect();
    mc.connect();
    assert.equal(FakeWebSocket.instances.length, 1, 'idempotent while already open');
    assert.equal(statuses[0], 'connecting');
  });
});

test('an unsolicited drop reports disconnected, and the next foreground reopens', () => {
  withFakeWebSocket(() => {
    const { mc, statuses, fireForeground } = harness();
    mc.connect();
    FakeWebSocket.instances[0].fire('close'); // the socket drops on its own
    assert.ok(statuses.includes('disconnected'), 'an unsolicited close is surfaced');
    fireForeground();
    assert.equal(FakeWebSocket.instances.length, 2, 'coming to the foreground reopens the dropped socket');
  });
});

test('after disconnect() the foreground subscription is torn down and does not reopen', () => {
  withFakeWebSocket(() => {
    const { mc, fireForeground, wasUnsubscribed } = harness();
    mc.connect();
    mc.disconnect();
    assert.ok(wasUnsubscribed(), 'the foreground subscription was removed');
    const before = FakeWebSocket.instances.length;
    fireForeground();
    assert.equal(FakeWebSocket.instances.length, before, 'a user disconnect must never silently reopen');
  });
});
