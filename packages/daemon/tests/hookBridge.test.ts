// First unit test for the hook bridge, added with its migration to the shared LineFramer. It drives a
// real socket: an approval_request line opens an approval, a non-request line and malformed JSON are
// ignored without crashing. The byte cap itself is covered by lineFramer.test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createHookServer } from '../src/interface/hookBridge.ts';

function harness(brokerOpenReturns = true) {
  const opened: any[] = [];
  const broker = {
    open: (approval: any) => { opened.push(approval); return brokerOpenReturns; },
    abandon: () => {},
  } as any;
  const server = createHookServer({
    broker,
    sessionByClaudeId: () => undefined,
    selfDenyMs: 1000,
    broadcast: () => {},
    log: () => {},
  });
  return { server, opened };
}

async function serve(server: net.Server): Promise<{ sock: net.Socket; port: number }> {
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const sock = net.connect(port, '127.0.0.1');
  await once(sock, 'connect');
  return { sock, port };
}

function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => { if (cond()) { clearInterval(t); resolve(); } }, 5);
    setTimeout(() => { clearInterval(t); reject(new Error('timeout')); }, ms);
  });
}

test('an approval_request line opens an approval with the mapped fields', async () => {
  const { server, opened } = harness();
  const { sock } = await serve(server);
  sock.write(JSON.stringify({
    kind: 'approval_request',
    event: { tool_use_id: 't1', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } },
  }) + '\n');
  await waitFor(() => opened.length >= 1);
  assert.equal(opened[0].toolUseId, 't1');
  assert.equal(opened[0].toolName, 'Bash');
  assert.equal(opened[0].toolInput.command, 'ls');
  sock.destroy();
  server.close();
});

test('a non-approval-request line and malformed JSON are ignored without crashing', async () => {
  const { server, opened } = harness();
  const { sock } = await serve(server);
  sock.write(JSON.stringify({ kind: 'something_else' }) + '\n');
  sock.write('{ not json\n');
  // then a real request, to prove the connection still works after the ignored lines
  sock.write(JSON.stringify({ kind: 'approval_request', event: { tool_use_id: 't2', tool_name: 'Edit' } }) + '\n');
  await waitFor(() => opened.length >= 1);
  assert.equal(opened.length, 1, 'only the real request opened an approval');
  assert.equal(opened[0].toolUseId, 't2');
  sock.destroy();
  server.close();
});
