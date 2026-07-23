// Proves the mobile client STACK works end to end: the shared reliability engine (ReliableClient),
// driven through the RN SessionCrypto adapter (pure-JS @noble), interoperates with the daemon's own
// crypto byte-for-byte. The daemon side here is `@claude-code-remote/protocol/node` (node:crypto),
// standing in for the real daemon; that import is TEST-ONLY (it simulates the peer) and is never part
// of the app bundle, which uses only frameCrypto.
//
// If the derived keys, the AAD/direction binding, or the sealed-frame format diverged between the two
// implementations, the client could not open a daemon-sealed event and the daemon could not open a
// client-sent command, and this test would fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ReliableClient, type ServerEvent } from '@claude-code-remote/protocol';
import {
  generateIdentity, exportPublic, importPublic,
  deriveSessionKey as deriveDaemonKey, seal as sealDaemon, open as openDaemon,
} from '@claude-code-remote/protocol/node';
import { generateKeyPair, spkiPublicKeyB64, rawPublicKeyFromB64 } from '../crypto/frameCrypto.ts';
import { createSessionCrypto } from './sessionCrypto.ts';

/** Wire up a paired device + daemon, complete the handshake, and return both sides' primitives. */
function pairedSession() {
  // Daemon identity (node:crypto). Its raw X25519 public key is what the app stores from pairing.
  const daemon = generateIdentity();
  const daemonSpkiB64 = exportPublic(daemon.publicKey);
  const daemonPubRaw = rawPublicKeyFromB64(daemonSpkiB64);

  // Device identity (RN @noble). Its public key, DER-wrapped, is what the daemon registers.
  const device = generateKeyPair();
  const devicePubKeyObj = importPublic(spkiPublicKeyB64(device.publicKey));

  const salt = randomBytes(32);
  const saltB64 = salt.toString('base64');
  const daemonKey = deriveDaemonKey(daemon.privateKey, devicePubKeyObj, salt);

  const events: [ServerEvent, number][] = [];
  const acks: number[] = [];
  let ready = false;
  let seq = 0;
  const client = new ReliableClient({
    deviceId: 'mobile-1',
    crypto: createSessionCrypto(device.privateKey, daemonPubRaw),
    nextSeq: () => ++seq,
    onReady: () => { ready = true; },
    onEvent: (event, s) => events.push([event, s]),
    onAck: (upTo) => acks.push(upTo),
  });

  client.onOpen();
  client.drain(); // the hello
  client.onMessage({ type: 'session_salt', salt: saltB64, resumed: false });
  return { client, daemonKey, events, acks, ready: () => ready };
}

test('the handshake derives a matching key: the client opens a daemon-sealed event', () => {
  const { client, daemonKey, events, ready } = pairedSession();
  assert.equal(ready(), true, 'onReady fired after session_salt');

  const event: ServerEvent = { type: 'approval_pending', approval: { toolUseId: 'tu-1' } as any };
  const frame = sealDaemon(daemonKey, 1, event, 'd2c'); // daemon seals; client must open with the RN crypto
  client.onMessage(frame);

  assert.deepEqual(events, [[event, 1]], 'the RN client decrypted and delivered the daemon-sealed event');
});

test('a command the client sends is decryptable by the daemon (RN seal -> node open)', () => {
  const { client, daemonKey } = pairedSession();
  const command = { type: 'decide', toolUseId: 'tu-1', decision: 'allow', by: 'phone' };
  client.send(command, { reliable: true });

  const out = client.drain();
  assert.equal(out.length, 1, 'one sealed frame to write');
  const recovered = openDaemon(daemonKey, out[0] as any, 'c2d');
  assert.deepEqual(recovered, command, 'the daemon opened the client-sealed c2d command');
});

test('a daemon ack advances the client, and a reflected frame is rejected (direction binding)', () => {
  const { client, daemonKey, acks } = pairedSession();

  // Ack from the daemon.
  client.onMessage(sealDaemon(daemonKey, 1, { type: 'ack', upTo: 5 }, 'd2c'));
  assert.deepEqual(acks, [5]);
  assert.equal(client.lastAcked, 5);

  // A frame the daemon sealed for the CLIENT direction, reflected back as if into the daemon, must
  // not open as d2c: seal it c2d and feed it in. The client opens d2c, so authentication fails and it
  // is dropped, not delivered.
  const reflected = sealDaemon(daemonKey, 2, { type: 'ack', upTo: 999 }, 'c2d');
  client.onMessage(reflected);
  assert.equal(client.lastAcked, 5, 'the reflected frame did not advance ack accounting');
});
