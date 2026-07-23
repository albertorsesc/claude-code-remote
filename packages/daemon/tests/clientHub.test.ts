// ClientHub.broadcast() must assign exactly ONE seq per device per event, even when a
// device holds more than one live socket (the documented `cc watch` + `cc allow` two-connection
// usage). Drawing a seq per socket recorded the same event twice in the device's replay log under
// two seqs, so each connection tracked a divergent counter and a reconnect replayed an event the
// peer had already rendered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '@claude-code-remote/protocol/node';
import { ClientHub } from '../src/interface/clientHub.ts';
import { DeviceSessionRegistry } from '../src/domain/deviceSessions.ts';

/** A minimal stand-in for net.Socket: ClientHub only uses write + writableLength here. */
function fakeSocket() {
  const frames: any[] = [];
  return {
    frames,
    writableLength: 0,
    write(line: string) { frames.push(JSON.parse(line)); return true; },
    destroy() {},
  } as any;
}

const KEY = Buffer.alloc(32, 7); // any valid 32-byte AES key; both sockets share the device key here

test('one broadcast draws one seq per device, even with two sockets for that device', () => {
  const reg = new DeviceSessionRegistry();
  const hub = new ClientHub(reg, () => {});

  const sockA = fakeSocket();
  const sockB = fakeSocket();
  hub.authenticate(sockA, { key: KEY, deviceId: 'dev1' });
  hub.authenticate(sockB, { key: KEY, deviceId: 'dev1' });

  hub.broadcast({ type: 'session_update', session: { id: 's1', label: 'x' } as any });

  assert.equal(sockA.frames.length, 1, 'socket A received the event once');
  assert.equal(sockB.frames.length, 1, 'socket B received the event once');
  assert.equal(sockA.frames[0].seq, sockB.frames[0].seq,
    'both sockets of the one device see the SAME seq for the one event');
  assert.equal(sockA.frames[0].seq, 1, 'exactly one seq was consumed, not two');

  // The replay log recorded the event ONCE (at seq 1), so a reconnect from seq 1 replays nothing.
  const { resume } = reg.resumeFor('dev1', 1);
  assert.ok(resume);
  assert.equal(resume!.events.length, 0, 'no phantom duplicate sits in the replay log to re-render');

  // And the frame each socket got is genuinely openable under the shared key (real seal, not a stub).
  // broadcast seals daemon→client, so it opens as 'd2c'.
  assert.deepEqual((open(KEY, sockA.frames[0], 'd2c') as any).type, 'session_update');
});

test('distinct devices still advance their own counters independently', () => {
  const reg = new DeviceSessionRegistry();
  const hub = new ClientHub(reg, () => {});
  const a = fakeSocket();
  const b = fakeSocket();
  hub.authenticate(a, { key: KEY, deviceId: 'devA' });
  hub.authenticate(b, { key: KEY, deviceId: 'devB' });

  hub.broadcast({ type: 'error', message: 'one' });
  hub.broadcast({ type: 'error', message: 'two' });

  assert.deepEqual(a.frames.map((f: any) => f.seq), [1, 2], 'devA gets its own 1,2');
  assert.deepEqual(b.frames.map((f: any) => f.seq), [1, 2], 'devB gets its own 1,2, independent stream');
});
