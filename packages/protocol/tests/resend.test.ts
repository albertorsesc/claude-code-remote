// ResendBuffer, the client's reverse buffer for command redelivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResendBuffer } from '../src/resend.ts';
// Moved from packages/cli/tests: the buffer now lives in the shared kernel, so its test travels with it.

test('add then ackUpTo drops only the acked seqs', () => {
  const b = new ResendBuffer();
  b.add(1, { type: 'spawn' });
  b.add(2, { type: 'send' });
  b.add(3, { type: 'decide' });
  assert.equal(b.size, 3);

  b.ackUpTo(2);
  assert.equal(b.size, 1);
  assert.deepEqual(b.pending().map(([seq]) => seq), [3], 'only the unacked seq remains');
});

test('pending() returns unacked commands in ascending seq order (resend order)', () => {
  const b = new ResendBuffer();
  b.add(3, { c: 3 });
  b.add(1, { c: 1 });
  b.add(2, { c: 2 });
  assert.deepEqual(b.pending().map(([seq]) => seq), [1, 2, 3]);
});

test('add returns false at capacity, the caller must hard-fail, never silently drop', () => {
  const b = new ResendBuffer(2);
  assert.equal(b.add(1, {}), true);
  assert.equal(b.add(2, {}), true);
  assert.equal(b.isFull, true);
  assert.equal(b.add(3, {}), false, 'over capacity: refuse, do not drop-oldest');
  assert.equal(b.size, 2, 'the buffer did not silently evict anything');
});

test('ackUpTo below the lowest pending seq is a no-op', () => {
  const b = new ResendBuffer();
  b.add(5, {});
  b.ackUpTo(3);
  assert.equal(b.size, 1);
});
