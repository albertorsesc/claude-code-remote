// The push use case: it sits between the registration store and the sender. Tested with fakes for
// both, so the routing (who to notify, when to send, what to persist) is verified without sqlite or
// a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPushService } from '../src/application/pushService.ts';

function fakeStore() {
  const rows = new Map<string, { token: string; platform: string; at: number }>();
  return {
    rows,
    upsertPushRegistration: (deviceId: string, token: string, platform: any, at: number) =>
      rows.set(deviceId, { token, platform, at }),
    listPushTokens: () => [...rows.values()].map((r) => r.token),
    deletePushRegistration: (deviceId: string) => { rows.delete(deviceId); },
  };
}

function fakeSender() {
  const calls: string[][] = [];
  return { calls, send: (tokens: string[]) => { calls.push(tokens); return Promise.resolve(); } };
}

test('register persists the token, platform, and timestamp keyed by device', () => {
  const store = fakeStore();
  const svc = createPushService({ store, sender: fakeSender(), now: () => 1234, log: () => {} });
  svc.register('dev-1', 'ExponentPushToken[a]', 'ios');
  assert.deepEqual(store.rows.get('dev-1'), { token: 'ExponentPushToken[a]', platform: 'ios', at: 1234 });
});

test('register again for the same device rotates the token (upsert, one row per device)', () => {
  const store = fakeStore();
  const svc = createPushService({ store, sender: fakeSender(), now: () => 1, log: () => {} });
  svc.register('dev-1', 'old', 'ios');
  svc.register('dev-1', 'new', 'ios');
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get('dev-1')!.token, 'new');
});

test('unregister removes the device registration', () => {
  const store = fakeStore();
  const svc = createPushService({ store, sender: fakeSender(), now: () => 1, log: () => {} });
  svc.register('dev-1', 't', 'android');
  svc.unregister('dev-1');
  assert.equal(store.rows.size, 0);
});

test('notifyApprovalPending sends every registered token to the sender', () => {
  const store = fakeStore();
  const sender = fakeSender();
  const svc = createPushService({ store, sender, now: () => 1, log: () => {} });
  svc.register('dev-1', 'tok-1', 'ios');
  svc.register('dev-2', 'tok-2', 'android');
  svc.notifyApprovalPending();
  assert.deepEqual(sender.calls, [['tok-1', 'tok-2']]);
});

test('notifyApprovalPending with no registered devices never calls the sender', () => {
  const sender = fakeSender();
  const svc = createPushService({ store: fakeStore(), sender, now: () => 1, log: () => {} });
  svc.notifyApprovalPending();
  assert.deepEqual(sender.calls, [], 'no tokens → no send, not an empty push');
});

test('a rejected send is swallowed (fail-soft): notify never throws into the broker handler', () => {
  const store = fakeStore();
  store.upsertPushRegistration('dev-1', 'tok', 'ios', 1);
  const svc = createPushService({
    store,
    sender: { send: () => Promise.reject(new Error('network down')) },
    now: () => 1,
    log: () => {},
  });
  // The broker's `pending` handler is synchronous; a throw here would take the daemon down.
  assert.doesNotThrow(() => svc.notifyApprovalPending());
});
