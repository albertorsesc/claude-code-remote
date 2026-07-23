// DeviceSessionRegistry composes OutboundStream + DeviceReplayLog for the actual
// resumeFor()/recordSent() flow used by index.ts's `hello` handler and broadcast().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSessionRegistry } from '../src/domain/deviceSessions.ts';

test('first-ever hello (no lastSeq) always gets resume: null', () => {
  const reg = new DeviceSessionRegistry();
  const { resume } = reg.resumeFor('dev1', undefined);
  assert.equal(resume, null);
});

test('resumeFor with a valid lastSeq after recordSent calls returns exactly the missing events', () => {
  const reg = new DeviceSessionRegistry();
  reg.resumeFor('dev1', undefined); // establishes the device (first hello)
  reg.recordSent('dev1', { type: 'error', message: 'a' });
  reg.recordSent('dev1', { type: 'error', message: 'b' });
  reg.recordSent('dev1', { type: 'error', message: 'c' });

  const { resume } = reg.resumeFor('dev1', 1);
  assert.ok(resume);
  assert.deepEqual(resume!.events.map((e) => e.seq), [2, 3]);
});

test('a lastSeq claimed against a device this registry has never seen forces resume: null, not a false "nothing missed"', () => {
  // Simulates a daemon restart: the on-disk identity still recognizes the device (out of
  // scope here, that's identity.ts), but this in-memory registry is a fresh instance with
  // no record of it. A plausible-looking lastSeq must NOT be trusted as "you're caught up".
  const reg = new DeviceSessionRegistry();
  const { resume } = reg.resumeFor('never-seen-before', 42);
  assert.equal(resume, null, 'must force a full resync, never claim nothing was missed');
});

test('a buffer-overflow gap also forces resume: null (full resync), not a partial replay', () => {
  const reg = new DeviceSessionRegistry(200, 3); // tiny per-device buffer
  reg.resumeFor('dev1', undefined);
  for (let i = 1; i <= 10; i++) reg.recordSent('dev1', { type: 'error', message: `${i}` });

  const { resume } = reg.resumeFor('dev1', 1); // way behind the 3-event buffer
  assert.equal(resume, null);
});

test('recordSent works standalone, with no prior resumeFor call (the broadcast-to-offline-devices fix)', () => {
  // This is the exact mechanism a failing integration test caught was missing: broadcast()
  // must be able to record for a device it already knows about (via knownDeviceIds()) even
  // while that device is disconnected, not just for sockets currently in the live client map.
  // recordSent() must work standalone for that offline-recording loop to be possible at all.
  //
  // Note: recordSent() only ever gets called by broadcast() for deviceIds already returned by
  // knownDeviceIds(), which are only ever added via a prior resumeFor() (a real hello). So a
  // device genuinely never seen by this registry can't reach broadcast's offline path; this
  // test only proves the standalone mechanism works, not a realistic call sequence.
  const reg = new DeviceSessionRegistry();
  const seq = reg.recordSent('some-device', { type: 'error', message: 'x' });
  assert.equal(seq, 1);
  assert.ok(reg.knownDeviceIds().includes('some-device'));
});

test('knownDeviceIds() lists every device ever sent to, connected or not', () => {
  const reg = new DeviceSessionRegistry();
  reg.resumeFor('dev1', undefined);
  reg.recordSent('dev2', { type: 'error', message: 'x' }); // never called resumeFor, "offline"
  assert.deepEqual(new Set(reg.knownDeviceIds()), new Set(['dev1', 'dev2']));
});

test('an LRU-evicted device reports the "never seen" branch again on its next resumeFor', () => {
  const reg = new DeviceSessionRegistry(1, 200); // cap of 1 device
  reg.resumeFor('dev1', undefined);
  reg.recordSent('dev1', { type: 'error', message: 'x' });

  reg.resumeFor('dev2', undefined); // evicts dev1 (LRU cap of 1)
  reg.recordSent('dev2', { type: 'error', message: 'y' });

  const { resume } = reg.resumeFor('dev1', 1);
  assert.equal(resume, null, 'evicted device must not falsely resume, its OutboundStream was dropped too');
});

test('evict() clears both the outbound seq counter and the replay log for a device', () => {
  const reg = new DeviceSessionRegistry();
  reg.resumeFor('dev1', undefined);
  reg.recordSent('dev1', { type: 'error', message: 'x' });
  reg.evict('dev1');

  assert.ok(!reg.knownDeviceIds().includes('dev1'));
  const { resume } = reg.resumeFor('dev1', 1);
  assert.equal(resume, null);
});

test('replayed events never advance the seq counter, recordSent is only called by real sends', () => {
  const reg = new DeviceSessionRegistry();
  reg.resumeFor('dev1', undefined);
  const seq1 = reg.recordSent('dev1', { type: 'error', message: 'a' });
  assert.equal(seq1, 1);

  reg.resumeFor('dev1', 0); // reconnect, resume from 0, must not itself advance the counter
  const seq2 = reg.recordSent('dev1', { type: 'error', message: 'b' });
  assert.equal(seq2, 2, 'the seq counter only advances on real sends, resuming does not consume a seq');
});

// --- Command redelivery: inbound dedup ---

test('acceptInbound dedups a repeated seq, the reason a resent command is not re-executed', () => {
  const reg = new DeviceSessionRegistry();
  assert.equal(reg.acceptInbound('dev1', 1), true, 'first time seq 1 is new');
  assert.equal(reg.acceptInbound('dev1', 1), false, 'a resend of seq 1 is dropped, not re-executed');
  assert.equal(reg.acceptInbound('dev1', 2), true, 'seq 2 is new');
});

test('inbound dedup survives a reconnect (it is per-device, not per-connection)', () => {
  const reg = new DeviceSessionRegistry();
  reg.acceptInbound('dev1', 1);
  // "reconnect" is just another hello for the same device, no new registry, no reset.
  reg.resumeFor('dev1', 0);
  assert.equal(reg.acceptInbound('dev1', 1), false, 'a command from before the drop is still deduped after reconnect');
});

test('inboundLastSeq reports the highest accepted seq, 0 for an unknown device', () => {
  const reg = new DeviceSessionRegistry();
  assert.equal(reg.inboundLastSeq('unknown'), 0);
  reg.acceptInbound('dev1', 1);
  reg.acceptInbound('dev1', 2);
  assert.equal(reg.inboundLastSeq('dev1'), 2);
});

test('inbound dedup is NOT LRU-evicted when replay/outbound state is', () => {
  // The replay LRU cap is per-DEVICE-count; evicting a device's replay+outbound state must NOT
  // reset its inbound dedup, or a resent command would be re-accepted and re-executed (a resent
  // spawn -> a second session). Cap the replay device map at 1 to force an eviction.
  const reg = new DeviceSessionRegistry(1, 200);
  reg.resumeFor('dev1', undefined);
  reg.recordSent('dev1', { type: 'error', message: 'x' }); // dev1 now in the replay/outbound maps
  assert.equal(reg.acceptInbound('dev1', 1), true);        // dev1 processed inbound seq 1

  // A second device forces the replay LRU to evict dev1's replay+outbound state.
  reg.resumeFor('dev2', undefined);
  reg.recordSent('dev2', { type: 'error', message: 'y' });
  assert.ok(!reg.knownDeviceIds().includes('dev1'), 'dev1 replay/outbound state was LRU-evicted');

  // ...but dev1's inbound dedup MUST still remember seq 1, or a resend would re-execute.
  assert.equal(reg.acceptInbound('dev1', 1), false, 'inbound dedup survives replay LRU eviction, no double-execution');
});

test('evict clears inbound dedup too (revoke fully forgets the device)', () => {
  const reg = new DeviceSessionRegistry();
  reg.acceptInbound('dev1', 1);
  reg.evict('dev1');
  // After a revoke the device is gone; a fresh pairing would legitimately start over.
  assert.equal(reg.acceptInbound('dev1', 1), true, 'evict resets inbound dedup');
});

// --- the ack level must never confirm a command that did not succeed ---
//
// An ack is CUMULATIVE: `upTo: 6` tells the client every command through 6 is done, and the client
// drops all of them from its resend buffer. So the level may only advance across a contiguous run
// of successes. Reporting a high-water mark instead meant a later success implicitly confirmed an
// earlier failure, and the client reported success for a command that never ran.

test('ackLevel advances only across a contiguous run of successes', () => {
  const reg = new DeviceSessionRegistry();
  assert.equal(reg.ackLevel('d1'), 0, 'nothing processed yet');

  reg.markProcessed('d1', 1);
  assert.equal(reg.ackLevel('d1'), 1);
  reg.markProcessed('d1', 2);
  assert.equal(reg.ackLevel('d1'), 2);
});

test('a FAILED command stalls the ack level, and later successes cannot confirm it', () => {
  const reg = new DeviceSessionRegistry();
  reg.markProcessed('d1', 1);
  // command 2 threw, it is never marked.
  reg.markProcessed('d1', 3);
  reg.markProcessed('d1', 4);

  assert.equal(reg.ackLevel('d1'), 1,
    'the client must never be told 2 succeeded because 3 and 4 did');
});

test('a gap closes if the missing command is later processed', () => {
  const reg = new DeviceSessionRegistry();
  reg.markProcessed('d1', 1);
  reg.markProcessed('d1', 3);
  reg.markProcessed('d1', 4);
  assert.equal(reg.ackLevel('d1'), 1);

  reg.markProcessed('d1', 2);   // the gap is filled
  assert.equal(reg.ackLevel('d1'), 4, 'the level jumps to the end of the now-contiguous run');
});

test('accepted is not processed: acceptInbound alone never advances the ack level', () => {
  // This is the exact defect. acceptInbound runs BEFORE the handler, so if the handler throws the
  // seq is accepted (and permanently deduped) but must not be acknowledged.
  const reg = new DeviceSessionRegistry();
  assert.equal(reg.acceptInbound('d1', 1), true, 'accepted for handling');
  assert.equal(reg.ackLevel('d1'), 0, 'but not acknowledged until it actually succeeded');
});

test('processed state is dropped on revoke, like every other per-device record', () => {
  const reg = new DeviceSessionRegistry();
  reg.markProcessed('d1', 1);
  assert.equal(reg.ackLevel('d1'), 1);
  reg.evict('d1');
  assert.equal(reg.ackLevel('d1'), 0);
});

test('out-of-order successes do not double-count or regress the level', () => {
  const reg = new DeviceSessionRegistry();
  for (const seq of [3, 1, 2, 2, 5, 4]) reg.markProcessed('d1', seq);
  assert.equal(reg.ackLevel('d1'), 5);
  reg.markProcessed('d1', 1);   // a repeat must not move it backwards
  assert.equal(reg.ackLevel('d1'), 5);
});
