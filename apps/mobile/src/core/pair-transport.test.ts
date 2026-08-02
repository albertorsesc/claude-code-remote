// The pairing network step, exercised with a fake WebSocket so it runs under `node --test` with no
// device and no real socket. It proves the framing (one newline-terminated JSON line out), the
// success path (resolve on `paired`), the failure path (reject on `pair_failed`), and the timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completePairOverWebSocket, type PairCompleteMessage } from './pair-transport.ts';

type Listener = (event: unknown) => void;

/** A minimal stand-in for the global WebSocket that a test drives by hand. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;

  url: string;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

/** Install the fake as the global WebSocket for the duration of `run`, then restore. */
async function withFakeWebSocket<T>(run: () => Promise<T>): Promise<T> {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket as unknown;
  try {
    return await run();
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
}

const sampleComplete: PairCompleteMessage = {
  type: 'complete_pair',
  devicePublicKey: 'DEVICE_SPKI_B64',
  deviceName: 'my-phone',
  proof: 'PROOF_B64',
};

test('sends one newline-framed complete_pair and resolves on the paired reply', async () => {
  await withFakeWebSocket(async () => {
    const pending = completePairOverWebSocket('ws://127.0.0.1:7443', sampleComplete);
    const socket = FakeWebSocket.last;
    assert.ok(socket, 'a socket was opened');

    socket.emit('open');
    assert.equal(socket.sent.length, 1, 'exactly one frame was written');
    assert.equal(socket.sent[0], `${JSON.stringify(sampleComplete)}\n`, 'the frame is the complete_pair JSON plus a newline');

    socket.emit('message', { data: `${JSON.stringify({ type: 'paired', deviceId: 'dev-7', daemonPublicKey: 'DAEMON_PK' })}\n` });

    const result = await pending;
    assert.deepEqual(result, { deviceId: 'dev-7', daemonPublicKey: 'DAEMON_PK' });
    assert.equal(socket.closed, true, 'the socket is closed after settling');
  });
});

test('reassembles a paired reply that arrives split across two message events', async () => {
  await withFakeWebSocket(async () => {
    const pending = completePairOverWebSocket('ws://127.0.0.1:7443', sampleComplete);
    const socket = FakeWebSocket.last;
    assert.ok(socket);
    socket.emit('open');

    const full = `${JSON.stringify({ type: 'paired', deviceId: 'dev-9', daemonPublicKey: 'PK9' })}\n`;
    const split = Math.floor(full.length / 2);
    socket.emit('message', { data: full.slice(0, split) });
    socket.emit('message', { data: full.slice(split) });

    assert.deepEqual(await pending, { deviceId: 'dev-9', daemonPublicKey: 'PK9' });
  });
});

test('rejects when the daemon replies pair_failed', async () => {
  await withFakeWebSocket(async () => {
    const pending = completePairOverWebSocket('ws://127.0.0.1:7443', sampleComplete);
    const socket = FakeWebSocket.last;
    assert.ok(socket);
    socket.emit('open');
    socket.emit('message', { data: `${JSON.stringify({ type: 'pair_failed' })}\n` });

    await assert.rejects(pending, /rejected pairing/i);
    assert.equal(socket.closed, true);
  });
});

test('rejects after the timeout when the daemon never answers', async () => {
  await withFakeWebSocket(async () => {
    const pending = completePairOverWebSocket('ws://127.0.0.1:7443', sampleComplete, 10);
    const socket = FakeWebSocket.last;
    assert.ok(socket);
    socket.emit('open');
    // No reply. The short timeout should fire.
    await assert.rejects(pending, /timed out/i);
  });
});
