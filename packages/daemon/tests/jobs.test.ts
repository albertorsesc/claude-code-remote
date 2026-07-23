// JobQueue's state machine, in isolation, fake spawnSession, fake margin policy, real Db, no real
// daemon and no child process.
//
// These tests used to mkdtemp a project and write a real .claude/settings.json purely to get past
// the margin check, because the queue called the filesystem directly. With the check injected as a
// port, the queue's own behaviour (concurrency, refusal, state transitions) is exercised with no
// filesystem at all, and the margin RULE is tested separately and exhaustively in hookMargin.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Db } from '../src/infrastructure/db.ts';
import { JobQueue, mergeSnapshotJobs } from '../src/application/jobs.ts';

function freshDb(): Db {
  return new Db(path.join(os.tmpdir(), `cc-jobs-test-${randomUUID()}.db`));
}

/** Stands in for a real Session: same id/exit-emitting shape, no real child process. */
class FakeSession extends EventEmitter {
  id = randomUUID();
  cwd: string;
  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }
}

/** Margin policies as plain values, no project directory, no settings.json, no I/O. */
const ALLOWS = { check: () => ({ ok: true as const }) };
const REFUSES = { check: () => ({ ok: false as const, reason: 'hook margin too tight (test)' }) };
const PROJECT = '/does/not/need/to/exist';

test('enqueue under cap runs immediately (synchronous-feeling)', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  const q = new JobQueue({
    db, maxConcurrent: Infinity, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => { const s = new FakeSession(req.cwd); sessions.push(s); return s as any; },
    onSession: () => {},
    log: () => {},
  });

  const job = q.enqueue({ cwd: PROJECT }, 'dev1');
  assert.equal(job.state, 'running');
  assert.equal(sessions.length, 1);
  db.close();
});

test('enqueue over cap stays queued until capacity frees up', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  const q = new JobQueue({
    db, maxConcurrent: 1, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => { const s = new FakeSession(req.cwd); sessions.push(s); return s as any; },
    onSession: () => {},
    log: () => {},
  });

  const first = q.enqueue({ cwd: PROJECT }, 'dev1');
  const second = q.enqueue({ cwd: PROJECT }, 'dev1');
  assert.equal(first.state, 'running');
  assert.equal(second.state, 'queued');
  assert.equal(sessions.length, 1);

  sessions[0].emit('exit', 0);
  assert.equal(second.state, 'running');
  assert.equal(sessions.length, 2);
  db.close();
});

test('enqueue-time margin failure lands directly as failed, never touches running/queued', () => {
  const db = freshDb();
  let spawnCalled = false;
  const q = new JobQueue({
    db, maxConcurrent: Infinity, selfDenyMs: 1200000, hookMargin: REFUSES,
    spawnSession: () => { spawnCalled = true; return new FakeSession(PROJECT) as any; },
    onSession: () => {},
    log: () => {},
  });

  const job = q.enqueue({ cwd: PROJECT }, 'dev1');
  assert.equal(job.state, 'failed');
  assert.ok(job.error!.includes('refusing to spawn'));
  assert.equal(spawnCalled, false);
  db.close();
});

test('a failed session (nonzero exit) frees capacity for the next queued job', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  const q = new JobQueue({
    db, maxConcurrent: 1, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => { const s = new FakeSession(req.cwd); sessions.push(s); return s as any; },
    onSession: () => {},
    log: () => {},
  });

  const first = q.enqueue({ cwd: PROJECT }, 'dev1');
  const second = q.enqueue({ cwd: PROJECT }, 'dev1');
  sessions[0].emit('exit', 1); // nonzero exit
  assert.equal(first.state, 'failed');
  assert.equal(second.state, 'running');
  db.close();
});

test('list() reflects the current live job (a running job appears in the queue)', () => {
  const db = freshDb();
  const q = new JobQueue({
    db, maxConcurrent: Infinity, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => new FakeSession(req.cwd) as any,
    onSession: () => {},
    log: () => {},
  });

  q.enqueue({ cwd: PROJECT }, 'dev1');
  assert.equal(q.list().length, 1);
  db.close();
});

// --- a spawn that fails must not wedge the queue ---
//
// `running` is incremented before spawnSession() is called, and the session 'exit' handler that
// decrements it is only registered afterwards. So a spawn that throws leaves the slot reserved
// with nothing alive to release it: under a concurrency cap the queue stops forever, and the job
// sits in 'running' with no process behind it. Exactly the condition where the queue matters most
// (resource exhaustion: EMFILE, ENOMEM) is the condition most likely to make a spawn throw.

test('a spawn that throws marks the job failed rather than leaving it running forever', () => {
  const db = freshDb();
  const q = new JobQueue({
    db, maxConcurrent: 1, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: () => { throw new Error('spawn exploded (EMFILE)'); },
    onSession: () => {},
    log: () => {},
  });

  let job: any;
  assert.doesNotThrow(() => { job = q.enqueue({ cwd: PROJECT }, 'dev1'); },
    'a failed spawn must be handled by the queue, not thrown at whoever called enqueue');
  assert.equal(job.state, 'failed', 'the job is terminal, not stuck in running');
  assert.ok(job.error, 'and it carries a reason');
  db.close();
});

test('a spawn that throws releases the concurrency slot, so later jobs still start', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  let explode = true;
  const q = new JobQueue({
    db, maxConcurrent: 1, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => {
      if (explode) { explode = false; throw new Error('spawn exploded once'); }
      const s = new FakeSession(req.cwd); sessions.push(s); return s as any;
    },
    onSession: () => {},
    log: () => {},
  });

  try { q.enqueue({ cwd: PROJECT }, 'dev1'); } catch { /* asserted separately above */ }
  const second = q.enqueue({ cwd: PROJECT }, 'dev1');

  assert.equal(second.state, 'running',
    'the slot reserved by the failed spawn was released, otherwise cap=1 wedges the queue forever');
  assert.equal(sessions.length, 1, 'and the second job really did spawn');
  db.close();
});

// --- the live map is pruned on terminal states ---
//
// Retaining done/failed jobs forever leaked memory unboundedly AND made pumpQueue()'s per-completion
// scan O(total-lifetime-jobs) instead of O(concurrent). list() is the LIVE queue; finished jobs live
// in the durable store, not here.

test('a completed job is removed from the live queue (list() holds only queued/running)', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  const q = new JobQueue({
    db, maxConcurrent: Infinity, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => { const s = new FakeSession(req.cwd); sessions.push(s); return s as any; },
    onSession: () => {},
    log: () => {},
  });

  q.enqueue({ cwd: PROJECT }, 'dev1');
  q.enqueue({ cwd: PROJECT }, 'dev1');
  assert.equal(q.list().length, 2, 'both are running before either exits');
  sessions[0].emit('exit', 0);   // one completes
  assert.equal(q.list().length, 1, 'the finished job is pruned from the live queue');
  sessions[1].emit('exit', 1);   // the other fails
  assert.equal(q.list().length, 0, 'a failed job is pruned too, the live queue is empty');
  db.close();
});

test('an enqueue-time refusal never enters the live queue', () => {
  const db = freshDb();
  const q = new JobQueue({
    db, maxConcurrent: Infinity, selfDenyMs: 1200000, hookMargin: REFUSES,
    spawnSession: () => new FakeSession(PROJECT) as any,
    onSession: () => {},
    log: () => {},
  });
  const job = q.enqueue({ cwd: PROJECT }, 'dev1');
  assert.equal(job.state, 'failed');
  assert.equal(q.list().length, 0, 'a job that failed at birth is durable-only, never live');
  db.close();
});

test('list() and pumpQueue stay O(concurrent), not O(lifetime): 500 completed jobs leave an empty queue', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  const q = new JobQueue({
    db, maxConcurrent: 1, selfDenyMs: 1200000, hookMargin: ALLOWS,
    spawnSession: (req) => { const s = new FakeSession(req.cwd); sessions.push(s); return s as any; },
    onSession: () => {},
    log: () => {},
  });
  for (let i = 0; i < 500; i++) q.enqueue({ cwd: PROJECT }, 'dev1');
  // Drain: each exit starts the next queued job and prunes the finished one.
  for (let i = 0; i < 500; i++) sessions[i].emit('exit', 0);
  assert.equal(q.list().length, 0, 'nothing accumulates, the map does not grow with lifetime jobs');
  assert.equal(sessions.length, 500, 'all 500 ran');
  db.close();
});

// --- the dequeue-time refusal must NOT recurse into a stack overflow ---
//
// tryStart()'s dequeue-time margin refusal used to call pumpQueue() from inside pumpQueue()'s own
// loop, one stack frame per refused job. With a capped queue and a large backlog it overflowed the
// stack out of the unguarded 'exit' listener and took the daemon down. The margin is re-checked at
// dequeue, so a policy that flips to refuse after jobs are queued is the real trigger.

// --- the resync merge policy, unit-tested apart from the composition root ---

const job = (id: string, state: any): any => ({ id, cwd: '/x', state, requestedBy: 'd', createdAt: 0 });

test('mergeSnapshotJobs: live jobs first, then durable-only jobs', () => {
  const merged = mergeSnapshotJobs([job('a', 'running')], [job('b', 'failed'), job('c', 'done')]);
  assert.deepEqual(merged.map((j) => j.id), ['a', 'b', 'c']);
});

test('mergeSnapshotJobs: a job in BOTH sources appears once, the live copy winning', () => {
  const merged = mergeSnapshotJobs(
    [job('a', 'running')],
    [job('a', 'done'), job('b', 'failed')], // durable copy of 'a' is stale (a is still running live)
  );
  assert.deepEqual(merged.map((j) => j.id), ['a', 'b'], 'no duplicate id');
  assert.equal(merged.find((j) => j.id === 'a')!.state, 'running', 'the live copy wins on overlap');
});

test('mergeSnapshotJobs: empty live returns durable; empty durable returns live', () => {
  assert.deepEqual(mergeSnapshotJobs([], [job('b', 'failed')]).map((j) => j.id), ['b']);
  assert.deepEqual(mergeSnapshotJobs([job('a', 'running')], []).map((j) => j.id), ['a']);
});

test('a large queued backlog that all fails the dequeue margin drains without a stack overflow', () => {
  const db = freshDb();
  const sessions: FakeSession[] = [];
  let allow = true;
  const q = new JobQueue({
    db, maxConcurrent: 1, selfDenyMs: 1200000,
    hookMargin: { check: () => (allow ? { ok: true as const } : { ok: false as const, reason: 'margin flipped' }) },
    spawnSession: (req) => { const s = new FakeSession(req.cwd); sessions.push(s); return s as any; },
    onSession: () => {},
    log: () => {},
  });

  q.enqueue({ cwd: PROJECT }, 'dev1');                 // job 0 starts (allow)
  const N = 20000;                                     // far beyond any stack depth
  for (let i = 0; i < N; i++) q.enqueue({ cwd: PROJECT }, 'dev1'); // all queued behind cap=1
  allow = false;                                       // settings.json changed under the backlog

  assert.doesNotThrow(() => sessions[0].emit('exit', 0),
    'draining the backlog under a flipped margin must iterate, not recurse into RangeError');
  assert.equal(q.list().length, 0, 'every queued job was refused and pruned, none left stuck');
  db.close();
});
