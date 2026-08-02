// guardMessage is the daemon's crash backstop, and its boolean return is a load-bearing contract:
// an earlier void-returning version let the command path ack commands whose handler had thrown,
// turning a crash into silent loss plus a false confirmation to the client. These assertions pin the
// contract: true on success, false (with a logged stack) on throw, and never rethrow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardMessage } from '../src/interface/messageGuard.ts';

test('guardMessage returns true and logs nothing when the handler completes', () => {
  const logs: string[] = [];
  const ran = guardMessage((m) => { logs.push(String(m)); }, 'doing a thing', () => { /* completes */ });
  assert.equal(ran, true);
  assert.equal(logs.length, 0);
});

test('guardMessage returns false, logs the stack, and never rethrows when the handler throws', () => {
  const logs: string[] = [];
  let rethrew = false;
  let ran: boolean | undefined;
  try {
    ran = guardMessage((m) => { logs.push(String(m)); }, 'handling a bad frame', () => { throw new Error('boom'); });
  } catch {
    rethrew = true;
  }
  assert.equal(rethrew, false, 'the backstop must never rethrow');
  assert.equal(ran, false, 'a thrown handler reports not-done so the command path does not falsely ack');
  assert.equal(logs.length, 1, 'the failure is logged loudly, not swallowed silently');
  assert.match(logs[0], /handling a bad frame/, 'the log carries the context');
  assert.match(logs[0], /boom/, 'the log carries the error');
});
