// The fleet-state reducer is pure, so it is tested directly without a running app. This is the logic
// the screens depend on; the zustand/React binding around it is thin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerEvent } from '@claude-code-remote/protocol';
import {
  emptyFleetState, applyEvent, sessionList, pendingApprovals, pendingCount,
} from './fleetState.ts';

const session = (id: string, over: Partial<any> = {}) => ({
  id, claudeSessionId: null, cwd: '/p', label: id, state: 'working', model: null,
  startedAt: 0, lastActivityAt: 0, pendingApprovals: 0, ...over,
});
const fold = (events: ServerEvent[]) => events.reduce(applyEvent, emptyFleetState);

test('session_list replaces the fleet; session_update upserts', () => {
  let s = applyEvent(emptyFleetState, { type: 'session_list', sessions: [session('a'), session('b')] as any });
  assert.deepEqual(Object.keys(s.sessions).sort(), ['a', 'b']);
  s = applyEvent(s, { type: 'session_update', session: session('a', { state: 'idle' }) as any });
  assert.equal(s.sessions.a.state, 'idle', 'existing session updated in place');
  s = applyEvent(s, { type: 'session_update', session: session('c') as any });
  assert.ok(s.sessions.c, 'a new session is added');
});

test('an approval appears on pending and disappears on resolved', () => {
  const approval = { toolUseId: 'tu1', sessionId: 'a', toolName: 'Bash', toolInput: {}, requestedAt: 0, deadlineAt: 10 };
  let s = applyEvent(emptyFleetState, { type: 'approval_pending', approval: approval as any });
  assert.equal(pendingCount(s), 1);
  assert.equal(pendingApprovals(s)[0].toolUseId, 'tu1');
  s = applyEvent(s, { type: 'approval_resolved', toolUseId: 'tu1', decision: 'allow', by: 'me' });
  assert.equal(pendingCount(s), 0, 'a resolved approval is removed');
});

test('pending approvals are ordered by soonest deadline', () => {
  const mk = (id: string, deadlineAt: number) =>
    ({ type: 'approval_pending', approval: { toolUseId: id, sessionId: 'a', toolName: 'x', toolInput: {}, requestedAt: 0, deadlineAt } } as ServerEvent);
  const s = fold([mk('late', 100), mk('soon', 10), mk('mid', 50)]);
  assert.deepEqual(pendingApprovals(s).map((a) => a.toolUseId), ['soon', 'mid', 'late']);
});

test('sessions are ordered by most recent activity', () => {
  const s = fold([
    { type: 'session_update', session: session('old', { lastActivityAt: 1 }) as any },
    { type: 'session_update', session: session('new', { lastActivityAt: 9 }) as any },
    { type: 'session_update', session: session('mid', { lastActivityAt: 5 }) as any },
  ]);
  assert.deepEqual(sessionList(s).map((x) => x.id), ['new', 'mid', 'old']);
});

test('stream events accumulate per session and stay bounded', () => {
  let s = emptyFleetState;
  for (let i = 0; i < 250; i++) s = applyEvent(s, { type: 'stream', sessionId: 'a', event: { i } });
  assert.equal(s.transcripts.a.length, 200, 'the transcript is capped');
  assert.deepEqual(s.transcripts.a.at(-1), { i: 249 }, 'the newest event is kept');
});

test('job_update upserts; error sets a banner; history loads', () => {
  let s = applyEvent(emptyFleetState, { type: 'job_update', job: { id: 'j1', state: 'queued' } as any });
  assert.equal(s.jobs.j1.state, 'queued');
  s = applyEvent(s, { type: 'error', message: 'no session x' });
  assert.equal(s.lastError, 'no session x');
  s = applyEvent(s, { type: 'approval_history', approvals: [{ toolUseId: 't', decision: 'deny' } as any] });
  assert.equal(s.history.length, 1);
});

test('applyEvent never mutates the previous state', () => {
  const before = applyEvent(emptyFleetState, { type: 'session_update', session: session('a') as any });
  const snapshot = JSON.stringify(before);
  applyEvent(before, { type: 'session_update', session: session('b') as any });
  assert.equal(JSON.stringify(before), snapshot, 'the prior state object is unchanged');
});
