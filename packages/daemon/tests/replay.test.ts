// DeviceReplayLog is seq-addressable (record(deviceId, seq, ev) /
// replayFrom(deviceId, currentSeq, lastSeq)), matching the gap-detection contract the old
// OutboundStream.replayFrom had (moved here, see sync.ts's retirement note), and both
// eviction layers (explicit revoke, global LRU cap) actually bound memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceReplayLog } from '../src/domain/replay.ts';

test('record + replayFrom returns exactly the missing events, seq preserved exactly', () => {
  const log = new DeviceReplayLog();
  log.record('dev1', 1, { type: 'session_list', sessions: [] });
  log.record('dev1', 2, { type: 'error', message: 'x' });
  log.record('dev1', 3, { type: 'error', message: 'y' });
  log.record('dev2', 1, { type: 'error', message: 'z' });

  const { events, gap } = log.replayFrom('dev1', 3, 1);
  assert.equal(gap, false);
  assert.deepEqual(events.map((e) => e.seq), [2, 3]);
  assert.equal((events[0].event as any).message, 'x');

  assert.equal(log.replayFrom('dev2', 1, 1).events.length, 0, 'no events after currentSeq');
  assert.equal(log.replayFrom('unknown-device', 5, 1).events.length, 0);
});

test('replayFrom(currentSeq, lastSeq) with lastSeq >= currentSeq returns nothing new', () => {
  const log = new DeviceReplayLog();
  log.record('dev1', 1, { type: 'error', message: 'x' });
  const { events, gap } = log.replayFrom('dev1', 1, 1);
  assert.equal(events.length, 0);
  assert.equal(gap, false);
});

test('buffer overflow relative to lastSeq reports gap:true; within-buffer reports gap:false', () => {
  const log = new DeviceReplayLog(200, 5);
  for (let i = 1; i <= 10; i++) log.record('dev1', i, { type: 'error', message: `${i}` });

  // Buffer only holds the last 5 (seq 6..10); asking to resume from seq 1 is a gap.
  const behind = log.replayFrom('dev1', 10, 1);
  assert.equal(behind.gap, true);

  // Asking to resume from seq 7 (within the buffer) is not a gap.
  const within = log.replayFrom('dev1', 10, 7);
  assert.equal(within.gap, false);
  assert.deepEqual(within.events.map((e) => e.seq), [8, 9, 10]);
});

test('per-device event buffer is bounded, oldest events dropped first', () => {
  const log = new DeviceReplayLog(200, 5);
  for (let i = 1; i <= 10; i++) log.record('dev1', i, { type: 'error', message: `${i}` });
  const { events } = log.replayFrom('dev1', 10, 0);
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => e.seq), [6, 7, 8, 9, 10]);
});

test('evict() removes a device immediately (the revoke() hook)', () => {
  const log = new DeviceReplayLog();
  log.record('dev1', 1, { type: 'error', message: 'x' });
  assert.equal(log.deviceCount, 1);
  log.evict('dev1');
  assert.equal(log.deviceCount, 0);
  assert.equal(log.replayFrom('dev1', 1, 0).events.length, 0);
});

test('global device cap evicts the least-recently-seen device, not an arbitrary one', () => {
  const log = new DeviceReplayLog(2, 200);
  log.record('dev1', 1, { type: 'error', message: 'x' });
  log.touch('dev1');
  log.record('dev2', 1, { type: 'error', message: 'x' });
  log.touch('dev2');
  assert.equal(log.deviceCount, 2);

  // dev1 was touched before dev2, so dev1 is the least-recently-seen when dev3 arrives.
  const evicted = log.record('dev3', 1, { type: 'error', message: 'x' });
  assert.equal(evicted, 'dev1', 'record() reports which device it evicted');
  assert.equal(log.deviceCount, 2, 'cap of 2 devices must not be exceeded');
  assert.equal(log.replayFrom('dev1', 1, 0).events.length, 0, 'least-recently-seen device was evicted');
  assert.equal(log.replayFrom('dev2', 1, 0).events.length, 1, 'more-recently-seen device survives');
  assert.equal(log.replayFrom('dev3', 1, 0).events.length, 1, 'newly-added device survives');
});

test('a paired-once-and-never-returning device does not grow memory unboundedly across many peers', () => {
  const log = new DeviceReplayLog(50, 200);
  for (let i = 0; i < 500; i++) {
    log.record(`device-${i}`, 1, { type: 'error', message: 'x' });
  }
  assert.ok(log.deviceCount <= 50, `expected cap of 50 devices, got ${log.deviceCount}`);
});

// --- resume integrity: a client can only be trusted as "caught up" if its claim is possible ---
//
// The daemon answers `resumed: true` by sending NOTHING when it believes a client is current. That
// makes the "is this claim believable" check load-bearing: believing an impossible claim means the
// client silently receives no sessions, no jobs, and no PENDING APPROVALS, while being told it is
// up to date. A blocked tool call then waits for a decision the client was never asked for.
test('a lastSeq AHEAD of anything issued is a gap, never "caught up"', () => {
  const log = new DeviceReplayLog();
  log.record('dev1', 1, { type: 'session_list', sessions: [] } as any);
  log.record('dev1', 2, { type: 'session_list', sessions: [] } as any);

  // The client claims to have seen seq 1000; this process has only ever issued 2.
  const ahead = log.replayFrom('dev1', 2, 1000);
  assert.equal(ahead.gap, true,
    'claiming a seq this process never issued must force a full resync, not a silent "caught up"');
  assert.deepEqual(ahead.events, []);

  // One past current is still impossible, and must be treated the same way.
  const justAhead = log.replayFrom('dev1', 2, 3);
  assert.equal(justAhead.gap, true, 'even one seq ahead is impossible and must not be trusted');
});

test('lastSeq exactly equal to currentSeq is genuinely caught up (not a gap)', () => {
  const log = new DeviceReplayLog();
  log.record('dev1', 1, { type: 'session_list', sessions: [] } as any);
  const level = log.replayFrom('dev1', 1, 1);
  assert.equal(level.gap, false, 'an exact match is the one believable "nothing new" case');
  assert.deepEqual(level.events, []);
});

test('a device we have no buffer for, whose client is behind, is a gap', () => {
  // We cannot prove the client is current and have nothing to replay, so the only safe answer
  // is a full resync.
  const log = new DeviceReplayLog();
  const r = log.replayFrom('never-recorded', 5, 1);
  assert.equal(r.gap, true, 'behind, with nothing to replay, must force a full resync');
  assert.deepEqual(r.events, []);
});
