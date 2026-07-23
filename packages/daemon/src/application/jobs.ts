import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  HookMarginPolicy, Job, JobStore, Logger, SessionHandle, SpawnRequest,
} from './ports.ts';

// Re-exported because the job concept is owned here, even though the types are declared alongside
// the other ports. Consumers keep importing Job/SpawnRequest from the queue that produces them.
export type { Job, SpawnRequest };

/**
 * The jobs a resync snapshot should present: the live queue (queued/running) first, then recently
 * finished jobs read from the durable store, with any job in both (a running job is in the live map
 * AND has a durable row) shown once, the live copy winning. The queue prunes terminal jobs, so the
 * durable read is what stops a job a client spawned from silently vanishing after a daemon restart.
 * Pure and separate from the composition root so this merge policy is unit-testable.
 */
export function mergeSnapshotJobs(live: Job[], durable: Job[]): Job[] {
  const liveIds = new Set(live.map((j) => j.id));
  return [...live, ...durable.filter((j) => !liveIds.has(j.id))];
}

/**
 * Generic in the session type so the queue stays honest about what it hands back: it only ever
 * requires a SessionHandle, but it returns to `onSession` exactly the type `spawnSession` produced.
 * Without that, a composition root spawning concrete Sessions would receive them back widened to
 * the port and could not touch anything the port doesn't declare, which is precisely what the
 * type checker caught the moment one was introduced.
 *
 * Sync-feeling by default: a job runs immediately, same as a direct spawn, as long as it's under
 * maxConcurrent. Real queueing only happens once concurrency is actually capped and hit, so with
 * the default (unbounded), behavior is identical to spawning directly, just now durable and
 * audited. Event-driven, no polling timer: a finished job immediately tries the next queued one.
 *
 * Every dependency is a port, so the queue's own logic (margin refusal, concurrency, state
 * transitions) is exercisable with fakes and never reaches for a process or a database itself.
 */
interface JobQueueOpts<S extends SessionHandle> {
  db: JobStore;
  maxConcurrent: number;
  selfDenyMs: number;
  /** Injected rather than imported: the queue enforces the safety precondition without knowing
   *  that it is currently read out of a settings.json on disk. */
  hookMargin: HookMarginPolicy;
  spawnSession: (req: SpawnRequest) => S;
  onSession: (job: Job, session: S) => void;
  log: Logger;
}

export class JobQueue<S extends SessionHandle = SessionHandle> extends EventEmitter {
  /**
   * LIVE jobs only, queued and running. A job is removed the moment it reaches a terminal state
   * (done/failed), because its durable record already lives in the JobStore (insertJob/updateJobState)
   * and retaining terminal entries here was pure leak: unbounded memory, and pumpQueue()'s scan grew
   * O(n) in total-lifetime jobs instead of O(concurrent). The resync snapshot reads recent terminal
   * jobs from the durable store, not from this map, so pruning does not hide a finished job from a
   * reconnecting client.
   */
  private jobs = new Map<string, Job>();
  private running = 0;
  private opts: JobQueueOpts<S>;

  // Explicit assignment, not a parameter property: Node's strip-only TypeScript mode rejects
  // parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), and this project runs .ts directly
  // with no build step (same class of bug we hit in sync.ts: a TS parameter property that
  // node --check accepted but strip-only import rejected).
  constructor(opts: JobQueueOpts<S>) {
    super();
    this.opts = opts;
  }

  /** The live queue: queued and running jobs. Terminal jobs are pruned; read recent finished jobs
   *  from the durable store instead. */
  list(): Job[] {
    return [...this.jobs.values()];
  }

  enqueue(req: SpawnRequest, requestedBy: string): Job {
    const job: Job = {
      id: randomUUID(),
      cwd: req.cwd,
      label: req.label,
      disallowedTools: req.disallowedTools,
      model: req.model,
      permissionMode: req.permissionMode,
      effort: req.effort,
      state: 'queued',
      requestedBy,
      createdAt: Date.now(),
    };

    const margin = this.opts.hookMargin.check(req.cwd, this.opts.selfDenyMs);
    if (!margin.ok) {
      job.state = 'failed';
      job.error = `refusing to spawn: ${margin.reason}`;
      job.finishedAt = Date.now();
      // Terminal at birth: recorded durably and broadcast, but never enters the live map.
      this.opts.db.insertJob(job);
      this.opts.log(`refused spawn in ${req.cwd}: ${margin.reason}`);
      this.emit('update', job);
      return job;
    }

    this.jobs.set(job.id, job);
    this.opts.db.insertJob(job);
    this.emit('update', job);
    this.tryStart(job);
    return job;
  }

  private tryStart(job: Job) {
    if (job.state !== 'queued' || this.running >= this.opts.maxConcurrent) return;

    // Re-check right before spawning: settings.json could have changed while queued.
    const margin = this.opts.hookMargin.check(job.cwd, this.opts.selfDenyMs);
    if (!margin.ok) {
      job.state = 'failed';
      job.error = `refusing to spawn: ${margin.reason}`;
      job.finishedAt = Date.now();
      this.opts.db.updateJobState(job.id, { state: job.state, error: job.error, finishedAt: job.finishedAt });
      this.opts.log(`refused spawn in ${job.cwd} at dequeue: ${margin.reason}`);
      this.emit('update', job);
      this.jobs.delete(job.id);
      // No pumpQueue() here: this refusal freed no slot (running is unchanged), and when tryStart is
      // reached from pumpQueue's own loop that loop already advances to the next queued job. Calling
      // pumpQueue() from inside it instead recursed once per refused job, a stack overflow that
      // escaped this unguarded path and killed the daemon at a few thousand queued jobs.
      return;
    }

    job.state = 'running';
    job.startedAt = Date.now();
    this.running++;
    this.opts.db.updateJobState(job.id, { state: job.state, startedAt: job.startedAt });
    this.emit('update', job);

    // The slot is reserved above (running++), but the 'exit' handler that releases it is only
    // registered below, so anything that throws in between leaves the slot held by a job with no
    // process behind it. Under a concurrency cap that stops the queue permanently, and the failure
    // most likely to throw here is resource exhaustion (EMFILE/ENOMEM), which is precisely when the
    // queue needs to keep draining. Failing the job releases the slot and lets the queue continue.
    let session: S;
    try {
      session = this.opts.spawnSession({
        cwd: job.cwd, label: job.label, disallowedTools: job.disallowedTools,
        model: job.model, permissionMode: job.permissionMode, effort: job.effort,
      });
      job.sessionId = session.id;
      this.opts.db.updateJobState(job.id, { state: job.state, sessionId: session.id });
      this.opts.onSession(job, session);
    } catch (err: any) {
      this.running--;
      job.state = 'failed';
      job.error = `failed to spawn: ${err?.message ?? err}`;
      job.finishedAt = Date.now();
      this.opts.db.updateJobState(job.id, { state: job.state, error: job.error, finishedAt: job.finishedAt });
      this.opts.log(`spawn failed for job ${job.id} in ${job.cwd}: ${job.error}`);
      this.emit('update', job);
      this.jobs.delete(job.id);
      // No pumpQueue() here for the same reason as the dequeue-refusal path above: running is net
      // unchanged (++ then --), so no capacity was freed for another job, and this cannot strand a
      // queued job because queued jobs never coexist with spare capacity except transiently.
      return;
    }

    session.on('exit', (code: number | null, err?: Error) => {
      this.running--;
      job.state = code === 0 ? 'done' : 'failed';
      job.finishedAt = Date.now();
      if (job.state === 'failed') {
        job.error = err ? `failed to spawn: ${err.message}` : `session exited with code ${code}`;
      }
      this.opts.db.updateJobState(job.id, { state: job.state, error: job.error, finishedAt: job.finishedAt });
      this.emit('update', job);
      this.jobs.delete(job.id);
      // Legitimate pump: this exit genuinely freed a slot, so drain the next queued job. Deletion
      // above is before the scan so pumpQueue never revisits the just-finished job.
      this.pumpQueue();
    });
  }

  private pumpQueue() {
    for (const job of this.jobs.values()) {
      if (this.running >= this.opts.maxConcurrent) break;
      if (job.state === 'queued') this.tryStart(job);
    }
  }
}
