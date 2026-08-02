// The outbound seq counter is the app's anti-replay invariant: a seq must never repeat across
// launches or a stale command could be replayed. With persistence injected, that invariant is
// testable without the platform keystore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeqCounter, type SeqStore } from './seq.ts';

function fakeStore(initial = 0) {
  let persisted = initial;
  const saves: number[] = [];
  const store: SeqStore = {
    loadSeq: async () => persisted,
    saveSeq: async (v) => { persisted = v; saves.push(v); },
  };
  return { store, saves, current: () => persisted };
}

test('reserves a block up front, before handing out any seq', async () => {
  const f = fakeStore(0);
  const c = await createSeqCounter(f.store);
  assert.deepEqual(f.saves, [256], 'the ceiling (start + RESERVE) is persisted before the first next()');
  assert.equal(c.next(), 1);
});

test('next() is strictly increasing', async () => {
  const c = await createSeqCounter(fakeStore(0).store);
  assert.deepEqual([c.next(), c.next(), c.next()], [1, 2, 3]);
});

test('exhausting a block persists a new, higher reservation', async () => {
  const f = fakeStore(0);
  const c = await createSeqCounter(f.store); // ceiling 256
  for (let i = 0; i < 256; i++) c.next();     // the 256th hits the ceiling and re-reserves
  assert.equal(f.current(), 512, 'a fresh reservation past the exhausted block is persisted');
});

test('a kill mid-block: the next launch starts strictly above every seq the prior instance returned', async () => {
  const f = fakeStore(0);
  const first = await createSeqCounter(f.store);
  const returned = [first.next(), first.next(), first.next()]; // 1, 2, 3; persisted mark is still 256
  const second = await createSeqCounter(f.store);              // relaunch, seeded from the mark
  const afterRelaunch = second.next();
  assert.ok(afterRelaunch > Math.max(...returned), 'no seq is ever reused across launches');
  assert.equal(afterRelaunch, 257, 'it starts strictly above the prior reserved ceiling');
});
