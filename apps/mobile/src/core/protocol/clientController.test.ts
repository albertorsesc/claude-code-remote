// The RN client host, driven through a FAKE transport (captured writes + fed lines), with the daemon
// side supplied by node:crypto (test-only, simulating the peer). This proves the full path a screen
// will use: connected() -> hello; a fed session_salt makes it ready; a fed sealed event surfaces via
// onEvent; a send() produces a framed line the daemon can open; and the framing handles split/joined
// chunks. It is the mobile analogue of the CLI integration, minus the real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { ServerEvent } from '@claude-code-remote/protocol';
import {
  generateIdentity, exportPublic, importPublic,
  deriveSessionKey as deriveDaemonKey, seal as sealDaemon, open as openDaemon,
} from '@claude-code-remote/protocol/node';
import { generateKeyPair, spkiPublicKeyB64, rawPublicKeyFromB64 } from '../crypto/frameCrypto.ts';
import { createSessionCrypto } from './sessionCrypto.ts';
import { ClientController } from './clientController.ts';

function harness() {
  const daemon = generateIdentity();
  const daemonPubRaw = rawPublicKeyFromB64(exportPublic(daemon.publicKey));
  const device = generateKeyPair();
  const devicePubKeyObj = importPublic(spkiPublicKeyB64(device.publicKey));
  const salt = randomBytes(32);
  const daemonKey = deriveDaemonKey(daemon.privateKey, devicePubKeyObj, salt);

  const written: string[] = [];
  const events: [ServerEvent, number][] = [];
  let seq = 0;
  const ctrl = new ClientController({
    deviceId: 'phone-1',
    crypto: createSessionCrypto(device.privateKey, daemonPubRaw),
    nextSeq: () => ++seq,
    write: (line) => written.push(line),
    onEvent: (e, s) => events.push([e, s]),
  });

  /** A framed line the daemon would send. */
  const d2cLine = (s: number, ev: unknown) => JSON.stringify(sealDaemon(daemonKey, s, ev, 'd2c')) + '\n';
  const saltLine = () => JSON.stringify({ type: 'session_salt', salt: salt.toString('base64'), resumed: false }) + '\n';
  return { ctrl, daemonKey, written, events, d2cLine, saltLine };
}

test('connected() writes a hello; a fed session_salt makes the controller ready', () => {
  const { ctrl, written, saltLine } = harness();
  ctrl.connected();
  assert.equal(written.length, 1);
  assert.match(written[0], /"type":"hello"/);
  assert.equal(ctrl.ready, false, 'not ready until the key is derived');
  ctrl.feed(saltLine());
  assert.equal(ctrl.ready, true);
});

test('a fed sealed event is decrypted and surfaced via onEvent', () => {
  const { ctrl, events, saltLine, d2cLine } = harness();
  ctrl.connected();
  ctrl.feed(saltLine());
  const ev: ServerEvent = { type: 'session_update', session: { id: 's1' } as any };
  ctrl.feed(d2cLine(1, ev));
  assert.deepEqual(events, [[ev, 1]]);
});

test('send() produces a framed line the daemon can open (c2d)', () => {
  const { ctrl, daemonKey, written, saltLine } = harness();
  ctrl.connected();
  ctrl.feed(saltLine());
  written.length = 0;
  const cmd = { type: 'interrupt', sessionId: 's1' };
  ctrl.send(cmd);
  assert.equal(written.length, 1, 'one framed line written');
  assert.ok(written[0].endsWith('\n'), 'newline-framed');
  const frame = JSON.parse(written[0]);
  assert.deepEqual(openDaemon(daemonKey, frame, 'c2d'), cmd);
});

test('framing reassembles a message split across chunks and splits joined messages', () => {
  const { ctrl, events, saltLine, d2cLine } = harness();
  ctrl.connected();
  ctrl.feed(saltLine());
  const a = d2cLine(1, { type: 'session_update', session: { id: 'a' } });
  const b = d2cLine(2, { type: 'session_update', session: { id: 'b' } });
  // Split `a` across two feeds, then deliver `b` joined onto the tail of `a`.
  const mid = Math.floor(a.length / 2);
  ctrl.feed(a.slice(0, mid));
  assert.equal(events.length, 0, 'a partial line yields nothing yet');
  ctrl.feed(a.slice(mid) + b);
  assert.deepEqual(events.map(([, s]) => s), [1, 2], 'both messages framed correctly across the boundary');
});

test('the resume checkpoint survives a disconnect: the next hello carries lastSeq', () => {
  const { ctrl, written, saltLine, d2cLine } = harness();
  ctrl.connected();
  ctrl.feed(saltLine());
  ctrl.feed(d2cLine(4, { type: 'session_update', session: {} }));
  ctrl.disconnected();
  written.length = 0;
  ctrl.connected();
  assert.match(written[0], /"lastSeq":4/, 'reconnect resumes from the last accepted seq');
});
