// The session lifecycle-to-db mapping and the stderr policy used to live inline in the composition
// root, which no test imports. Extracted, they are exercised here against a fake session and store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachSessionPersistence } from '../src/application/sessionPersistence.ts';

class FakeSession extends EventEmitter {
  id = 's1';
  cwd = '/w';
  label = 'demo';
  startedAt = 100;
  claudeSessionId: string | null = null;
  model: string | null = null;
  lastActivityAt = 0;
  state = 'working';
}

function fakeStore() {
  const started: unknown[] = [];
  const activity: unknown[][] = [];
  const ended: unknown[][] = [];
  return {
    started, activity, ended,
    recordSessionStarted: (s: { id: string; cwd: string; label: string; startedAt: number }) => { started.push(s); },
    updateSessionActivity: (id: string, c: string | null, m: string | null, at: number) => { activity.push([id, c, m, at]); },
    recordSessionEnded: (id: string, st: string, code: number | null, at: number) => { ended.push([id, st, code, at]); },
  };
}

test('records the session start on attach', () => {
  const s = new FakeSession();
  const store = fakeStore();
  attachSessionPersistence(s as any, store, () => {});
  assert.deepEqual(store.started, [{ id: 's1', cwd: '/w', label: 'demo', startedAt: 100 }]);
});

test('a state change records the current activity', () => {
  const s = new FakeSession();
  const store = fakeStore();
  attachSessionPersistence(s as any, store, () => {});
  s.claudeSessionId = 'c1';
  s.model = 'opus';
  s.lastActivityAt = 5;
  s.emit('state');
  assert.equal(store.activity.length, 1);
  assert.deepEqual(store.activity[0].slice(0, 3), ['s1', 'c1', 'opus']);
});

test('exit records the final state and exit code', () => {
  const s = new FakeSession();
  const store = fakeStore();
  attachSessionPersistence(s as any, store, () => {});
  s.state = 'errored';
  s.emit('exit', 1);
  assert.equal(store.ended.length, 1);
  assert.deepEqual(store.ended[0].slice(0, 3), ['s1', 'errored', 1]);
});

test('stderr skips blank lines and truncates to 500 chars', () => {
  const s = new FakeSession();
  const logs: string[] = [];
  attachSessionPersistence(s as any, fakeStore(), (m: unknown) => logs.push(String(m)));
  s.emit('stderr', '   \n  '); // blank
  assert.equal(logs.length, 0, 'blank stderr is not logged');
  s.emit('stderr', 'x'.repeat(600));
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('x'.repeat(500)), 'keeps 500 chars');
  assert.ok(!logs[0].includes('x'.repeat(501)), 'drops the overflow');
});
