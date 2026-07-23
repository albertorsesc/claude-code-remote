// The Expo push adapter, exercised against a LOCAL http server standing in for exp.host. Zero
// external cost, but the whole HTTP path is real: method, headers, body shape, and the fail-soft
// contract. The endpoint is injectable precisely so this test (and the integration test) can point
// it at a mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createExpoPushSender, noopPushSender } from '../src/infrastructure/expoPush.ts';

type Captured = { method?: string; headers: http.IncomingHttpHeaders; body: string };

/** A mock endpoint that resolves `received` with the first request it captures. */
async function startMock() {
  let resolveReq!: (c: Captured) => void;
  const received = new Promise<Captured>((r) => { resolveReq = r; });
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      resolveReq({ method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ status: 'ok' }] }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/push`, received, hits: () => hits, close: () => server.close() };
}

test('POSTs one generic wake ping per token, carrying no per-approval data', async () => {
  const ep = await startMock();
  await createExpoPushSender(ep.url, () => {}).send(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
  const cap = await ep.received;
  ep.close();

  assert.equal(cap.method, 'POST');
  assert.equal(cap.headers['content-type'], 'application/json');

  const messages = JSON.parse(cap.body);
  assert.equal(messages.length, 2, 'one message per token');
  assert.deepEqual(messages.map((m: any) => m.to), ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
  for (const m of messages) {
    assert.equal(typeof m.title, 'string');
    assert.equal(typeof m.body, 'string');
    assert.deepEqual(m.data, { kind: 'approval' }, 'only a generic marker, no ids');
    // The privacy guarantee: nothing identifying a session/tool/approval leaves for the relay.
    assert.ok(!('sessionId' in m) && !('toolUseId' in m) && !('toolName' in m) && !('label' in m));
  }
});

test('no tokens → no request is made at all', async () => {
  const ep = await startMock();
  await createExpoPushSender(ep.url, () => {}).send([]);
  ep.close();
  assert.equal(ep.hits(), 0, 'an empty token list is a no-op, not an empty POST');
});

test('fail-soft: a connection error resolves and logs, never rejects', async () => {
  const logs: string[] = [];
  // Port 1 has nothing listening → ECONNREFUSED.
  const sender = createExpoPushSender('http://127.0.0.1:1/push', (m) => logs.push(String(m)));
  await assert.doesNotReject(() => sender.send(['tok']), 'a push failure must never propagate into the approval flow');
  assert.ok(logs.some((l) => l.includes('failed')), 'the failure is logged, not swallowed silently');
});

test('an invalid endpoint is logged and skipped, not thrown', async () => {
  const logs: string[] = [];
  await assert.doesNotReject(() => createExpoPushSender('not a url', (m) => logs.push(String(m))).send(['tok']));
  assert.ok(logs.some((l) => l.includes('invalid endpoint')));
});

test('noopPushSender resolves and sends nothing', async () => {
  await assert.doesNotReject(() => noopPushSender.send(['tok']));
});
