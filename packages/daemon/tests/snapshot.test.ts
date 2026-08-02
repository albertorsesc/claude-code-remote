// The first-hello snapshot order is a client-facing contract: a client renders session_list, then
// pending approvals, then jobs. This used to be assembled in the composition root where no test could
// reach it; these assertions pin the ordering and that live + recent jobs are merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo, PendingApproval } from '@claude-code-remote/protocol';
import type { Job } from '../src/application/ports.ts';
import { buildSnapshot } from '../src/application/snapshot.ts';

const session = (id: string): SessionInfo => ({
  id, claudeSessionId: null, cwd: '/w', label: id, state: 'working', model: null,
  startedAt: 0, lastActivityAt: 0, pendingApprovals: 0,
});
const approval = (toolUseId: string): PendingApproval => ({
  toolUseId, sessionId: 's', toolName: 'Bash', toolInput: {}, requestedAt: 0, deadlineAt: 0,
});
const job = (id: string, state: Job['state']): Job => ({
  id, cwd: '/w', state, requestedBy: 'dev', createdAt: 0,
});

test('an empty snapshot is still a single session_list event', () => {
  const snap = buildSnapshot([], [], [], []);
  assert.deepEqual(snap.map((e) => e.type), ['session_list']);
});

test('events are ordered session_list, then approvals, then jobs, never interleaved', () => {
  const snap = buildSnapshot(
    [session('a'), session('b')],
    [approval('t1'), approval('t2')],
    [job('j1', 'running')],
    [job('j2', 'done')],
  );
  assert.deepEqual(snap.map((e) => e.type), [
    'session_list', 'approval_pending', 'approval_pending', 'job_update', 'job_update',
  ]);
  const list = snap[0];
  assert.equal(list.type === 'session_list' && list.sessions.length, 2);
});

test('a live job and a distinct recent job both appear', () => {
  const snap = buildSnapshot([], [], [job('live', 'running')], [job('old', 'failed')]);
  const jobIds = snap.filter((e) => e.type === 'job_update').map((e) => (e as { job: Job }).job.id).sort();
  assert.deepEqual(jobIds, ['live', 'old']);
});
