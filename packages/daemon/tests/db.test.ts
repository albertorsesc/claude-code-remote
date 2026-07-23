// the durable store actually persists what it's told to, and reconciliation actually
// closes out rows a dead daemon process left dangling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/infrastructure/db.ts';

function freshDb(): Db {
  return new Db(path.join(os.tmpdir(), `cc-db-test-${randomUUID()}.db`));
}

test('approval request + decision roundtrip is queryable', () => {
  const db = freshDb();
  db.recordApprovalRequested({
    toolUseId: 'tu1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' },
    requestedAt: 1000, deadlineAt: 2000,
  });
  db.recordApprovalDecision('tu1', 'allow', 'looks fine', 'tester', 1500);

  const row = (db as any).db.prepare('SELECT * FROM approvals WHERE tool_use_id = ?').get('tu1');
  assert.equal(row.decision, 'allow');
  assert.equal(row.reason, 'looks fine');
  assert.equal(row.decided_by, 'tester');
  assert.equal(row.decided_at, 1500);
  assert.equal(JSON.parse(row.tool_input).command, 'ls');
  db.close();
});

test('queryRecentApprovals returns only decided approvals, most recent first, mapped to camelCase', () => {
  const db = freshDb();
  // One still-pending (never decided), must not appear.
  db.recordApprovalRequested({ toolUseId: 'pending', sessionId: 's', toolName: 'Bash', toolInput: {}, requestedAt: 1000, deadlineAt: 2000 });
  // Two decided, at different times.
  db.recordApprovalRequested({ toolUseId: 'older', sessionId: 's', toolName: 'Read', toolInput: {}, requestedAt: 1000, deadlineAt: 2000 });
  db.recordApprovalDecision('older', 'allow', 'ok', 'alice', 1500);
  db.recordApprovalRequested({ toolUseId: 'newer', sessionId: 's', toolName: 'Bash', toolInput: {}, requestedAt: 1000, deadlineAt: 2000 });
  db.recordApprovalDecision('newer', 'deny', 'nope', 'bob', 2500);

  const rows = db.queryRecentApprovals(10);
  assert.equal(rows.length, 2, 'the pending approval is excluded');
  assert.equal(rows[0].toolUseId, 'newer', 'most recent decision first');
  assert.equal(rows[0].decision, 'deny');
  assert.equal(rows[0].decidedBy, 'bob');
  assert.equal(rows[1].toolUseId, 'older');
  db.close();
});

test('queryRecentApprovals respects the limit', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i++) {
    db.recordApprovalRequested({ toolUseId: `t${i}`, sessionId: 's', toolName: 'Bash', toolInput: {}, requestedAt: 1000, deadlineAt: 2000 });
    db.recordApprovalDecision(`t${i}`, 'allow', '', 'x', 1000 + i);
  }
  assert.equal(db.queryRecentApprovals(3).length, 3);
  db.close();
});

test('session start + activity + end roundtrip', () => {
  const db = freshDb();
  db.recordSessionStarted({ id: 'sess1', cwd: '/tmp/proj', label: 'x', startedAt: 1000 });
  db.updateSessionActivity('sess1', 'claude-abc', 'sonnet', 1200);
  db.recordSessionEnded('sess1', 'finished', 0, 1400);

  const row = (db as any).db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess1');
  assert.equal(row.claude_session_id, 'claude-abc');
  assert.equal(row.model, 'sonnet');
  assert.equal(row.final_state, 'finished');
  assert.equal(row.exit_code, 0);
  db.close();
});

test('job insert + state transition roundtrip', () => {
  const db = freshDb();
  db.insertJob({ id: 'job1', cwd: '/tmp/proj', state: 'queued', requestedBy: 'dev1', createdAt: 1000 });
  db.updateJobState('job1', { state: 'running', startedAt: 1100 });
  db.updateJobState('job1', { state: 'done', finishedAt: 1300 });

  const row = (db as any).db.prepare('SELECT * FROM jobs WHERE id = ?').get('job1');
  assert.equal(row.state, 'done');
  assert.equal(row.started_at, 1100);
  assert.equal(row.finished_at, 1300);
  db.close();
});

// jobs must have a durable READ side, or a reconciled 'failed' job is invisible to a
// client after a restart (the in-memory queue is empty on a fresh process and the resync reads it).
test('queryRecentJobs returns recent jobs, most recent first, mapped to camelCase, including a reconciled failure', () => {
  const db = freshDb();
  db.insertJob({ id: 'j-old', cwd: '/tmp/a', label: 'old', state: 'done', requestedBy: 'dev1', createdAt: 1000, finishedAt: 1100 });
  db.insertJob({ id: 'j-mid', cwd: '/tmp/b', label: 'mid', disallowedTools: ['Bash'], state: 'running', requestedBy: 'dev1', createdAt: 2000, startedAt: 2050 });
  db.insertJob({ id: 'j-new', cwd: '/tmp/c', state: 'queued', requestedBy: 'dev2', createdAt: 3000 });
  db.reconcileOrphanedJobs(9999); // j-mid (running) + j-new (queued) become 'failed'

  const rows = db.queryRecentJobs(10);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.id), ['j-new', 'j-mid', 'j-old'], 'most recent createdAt first');
  const mid = rows.find((r) => r.id === 'j-mid')!;
  assert.equal(mid.state, 'failed', 'the reconciled job is queryable as failed');
  assert.deepEqual(mid.disallowedTools, ['Bash'], 'JSON columns are parsed back');
  assert.equal(mid.requestedBy, 'dev1');
  db.close();
});

test('queryRecentJobs respects the limit', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i++) db.insertJob({ id: `k${i}`, cwd: '/tmp', state: 'done', requestedBy: 'x', createdAt: 1000 + i, finishedAt: 1100 + i });
  assert.equal(db.queryRecentJobs(3).length, 3);
  db.close();
});

test('reconcileOrphanedJobs marks queued/running rows failed with a reason', () => {
  const db = freshDb();
  db.insertJob({ id: 'orphan1', cwd: '/tmp/proj', state: 'queued', requestedBy: 'dev1', createdAt: 1000 });
  db.insertJob({ id: 'orphan2', cwd: '/tmp/proj', state: 'running', requestedBy: 'dev1', createdAt: 1000, startedAt: 1050 });
  db.insertJob({ id: 'notorphan', cwd: '/tmp/proj', state: 'done', requestedBy: 'dev1', createdAt: 1000, finishedAt: 1200 });

  const changed = db.reconcileOrphanedJobs(9999);
  assert.equal(changed, 2);

  const rows = (db as any).db.prepare('SELECT id, state, error FROM jobs ORDER BY id').all();
  assert.deepEqual(rows.map((r: any) => r.state), ['done', 'failed', 'failed']);
  assert.ok(rows[1].error.includes('restarted'));
  db.close();
});

test('reconcileOrphanedSessions marks rows with no final_state as orphaned', () => {
  const db = freshDb();
  db.recordSessionStarted({ id: 'live', cwd: '/tmp/proj', label: 'x', startedAt: 1000 });
  db.recordSessionStarted({ id: 'dangling', cwd: '/tmp/proj', label: 'y', startedAt: 1000 });
  db.recordSessionEnded('live', 'finished', 0, 1200);

  const changed = db.reconcileOrphanedSessions(9999);
  assert.equal(changed, 1);

  const row = (db as any).db.prepare('SELECT final_state FROM sessions WHERE id = ?').get('dangling');
  assert.equal(row.final_state, 'orphaned');
  db.close();
});

test('push registrations: upsert rotates the token per device, list returns all, delete removes one', () => {
  const db = freshDb();
  db.upsertPushRegistration('dev-1', 'tok-a', 'ios', 1000);
  db.upsertPushRegistration('dev-2', 'tok-b', 'android', 1001);
  assert.deepEqual(db.listPushTokens().sort(), ['tok-a', 'tok-b']);

  // Same device re-registers: one row, new token (not a second row).
  db.upsertPushRegistration('dev-1', 'tok-a2', 'ios', 2000);
  assert.deepEqual(db.listPushTokens().sort(), ['tok-a2', 'tok-b']);

  db.deletePushRegistration('dev-1');
  assert.deepEqual(db.listPushTokens(), ['tok-b']);
  db.close();
});
