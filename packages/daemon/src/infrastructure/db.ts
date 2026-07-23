import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PendingApproval, ApprovalHistoryEntry, JobState, PushPlatform } from '@claudecode/protocol';
import type { Job } from '../application/ports.ts';

/**
 * Durable store for approval decisions, session history, and the job queue.
 *
 * Everything the daemon does today except identity/pairing is memory-only: approvals.ts drops a
 * decided approval 60s after decision, and Session objects vanish on restart. This is a pure
 * persistence layer, it records what EventEmitters already emit, it doesn't decide anything.
 *
 * node:sqlite is built into Node 24, so this needs no new dependency, matching the rest of the
 * daemon (crypto.ts, pairing.ts, hook/approve-bridge.mjs are all dependency-free). Still marked
 * experimental by the runtime as of this Node build, despite the current docs framing it as past
 * that stage, noted, not hidden.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS approvals (
  tool_use_id  TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  tool_input   TEXT NOT NULL,
  description  TEXT,
  requested_at INTEGER NOT NULL,
  deadline_at  INTEGER NOT NULL,
  decision     TEXT,
  reason       TEXT,
  decided_by   TEXT,
  decided_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_session   ON approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_approvals_requested ON approvals(requested_at);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  claude_session_id TEXT,
  cwd               TEXT NOT NULL,
  label             TEXT NOT NULL,
  model             TEXT,
  started_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL,
  ended_at          INTEGER,
  final_state       TEXT,
  exit_code         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  cwd              TEXT NOT NULL,
  label            TEXT,
  disallowed_tools TEXT,
  state            TEXT NOT NULL,
  session_id       TEXT,
  error            TEXT,
  requested_by     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, created_at);

CREATE TABLE IF NOT EXISTS push_registrations (
  device_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  platform   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class Db {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    // This store is not incidental data: it holds the audit trail of every tool call the sessions
    // proposed, and tool_input carries complete command lines, which routinely contain paths and
    // can contain secrets. It was landing at the umask (0644) while the identity store beside it
    // was deliberately 0600.
    //
    // The mode is applied to files we create, and to the directory ONLY when we create it. An
    // existing directory is left alone on purpose: dbPath is caller-supplied and its parent may be
    // a shared directory we have no business restricting, tests place databases directly in
    // os.tmpdir(), and chmod-ing that is both wrong (it is shared with every other process) and on
    // macOS impossible (EPERM, even for the owner).
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.restrictPermissions(dbPath);
    this.db.exec(SCHEMA);
    // WAL mode is enabled by the schema, so the -wal/-shm sidecars exist only from here on. They
    // hold recent transactions, so they need the same protection as the database itself.
    this.restrictPermissions(dbPath);
  }

  /** 0600 on the database and any SQLite sidecars that currently exist. Best-effort per file. */
  private restrictPermissions(dbPath: string) {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.chmodSync(f, 0o600);
      } catch {
        /* not created yet, or not ours to change, the database itself is what matters */
      }
    }
  }

  /**
   * Idempotent by tool_use_id. A bare INSERT here threw a UNIQUE violation out of an event handler
   * and killed the daemon process, taking every session and every pending approval with it.
   *
   * DO NOTHING rather than upsert is the honest semantic: the row records that this tool call was
   * requested, so seeing the same id again carries no new information, and overwriting would let a
   * later request rewrite the audit trail of an earlier one. Reachable without Claude ever reusing
   * an id, because the bridge falls back to `${session_id}-${Date.now()}` when tool_use_id is
   * absent, and two calls in one millisecond collide.
   */
  recordApprovalRequested(a: PendingApproval) {
    this.db.prepare(
      `INSERT INTO approvals (tool_use_id, session_id, tool_name, tool_input, description, requested_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_use_id) DO NOTHING`,
    ).run(a.toolUseId, a.sessionId, a.toolName, JSON.stringify(a.toolInput), a.description ?? null, a.requestedAt, a.deadlineAt);
  }

  recordApprovalDecision(toolUseId: string, decision: 'allow' | 'deny', reason: string, by: string, at: number) {
    this.db.prepare(
      `UPDATE approvals SET decision = ?, reason = ?, decided_by = ?, decided_at = ? WHERE tool_use_id = ?`,
    ).run(decision, reason, by, at, toolUseId);
  }

  recordSessionStarted(s: { id: string; cwd: string; label: string; startedAt: number }) {
    this.db.prepare(
      `INSERT INTO sessions (id, cwd, label, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(s.id, s.cwd, s.label, s.startedAt, s.startedAt);
  }

  updateSessionActivity(id: string, claudeSessionId: string | null, model: string | null, at: number) {
    this.db.prepare(
      `UPDATE sessions SET claude_session_id = ?, model = ?, last_activity_at = ? WHERE id = ?`,
    ).run(claudeSessionId, model, at, id);
  }

  recordSessionEnded(id: string, finalState: string, exitCode: number | null, at: number) {
    this.db.prepare(
      `UPDATE sessions SET ended_at = ?, final_state = ?, exit_code = ? WHERE id = ?`,
    ).run(at, finalState, exitCode, id);
  }

  /** Rows left `final_state IS NULL` from a daemon process that no longer exists. */
  reconcileOrphanedSessions(bootTime: number): number {
    const r = this.db.prepare(
      `UPDATE sessions SET ended_at = ?, final_state = 'orphaned' WHERE final_state IS NULL`,
    ).run(bootTime);
    return r.changes as number;
  }

  insertJob(job: Job) {
    this.db.prepare(
      `INSERT INTO jobs (id, cwd, label, disallowed_tools, state, session_id, error, requested_by, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id, job.cwd, job.label ?? null,
      job.disallowedTools ? JSON.stringify(job.disallowedTools) : null,
      job.state, job.sessionId ?? null, job.error ?? null, job.requestedBy,
      job.createdAt, job.startedAt ?? null, job.finishedAt ?? null,
    );
  }

  updateJobState(id: string, patch: { state: JobState; sessionId?: string; error?: string; startedAt?: number; finishedAt?: number }) {
    this.db.prepare(
      `UPDATE jobs SET state = ?, session_id = COALESCE(?, session_id), error = COALESCE(?, error),
       started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at) WHERE id = ?`,
    ).run(patch.state, patch.sessionId ?? null, patch.error ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, id);
  }

  /**
   * Recent jobs, most recent first, the read side of the job queue's durable state.
   *
   * The in-memory JobQueue map holds only live (queued/running) jobs, so a client that reconnects
   * after a daemon restart (or past its replay buffer) would otherwise never learn that a job
   * finished or was reconciled to 'failed'. The resync snapshot merges this with the live queue.
   */
  queryRecentJobs(limit = 50): Job[] {
    const rows = this.db.prepare(
      `SELECT id, cwd, label, disallowed_tools, state, session_id, error, requested_by, created_at, started_at, finished_at
       FROM jobs ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      cwd: r.cwd,
      label: r.label ?? undefined,
      disallowedTools: r.disallowed_tools ? JSON.parse(r.disallowed_tools) : undefined,
      state: r.state,
      sessionId: r.session_id ?? undefined,
      error: r.error ?? undefined,
      requestedBy: r.requested_by,
      createdAt: r.created_at,
      startedAt: r.started_at ?? undefined,
      finishedAt: r.finished_at ?? undefined,
    }));
  }

  /** Rows left `queued`/`running` from a daemon process that no longer exists. */
  reconcileOrphanedJobs(bootTime: number): number {
    const r = this.db.prepare(
      `UPDATE jobs SET state = 'failed', error = 'daemon restarted before this completed', finished_at = ?
       WHERE state IN ('queued', 'running')`,
    ).run(bootTime);
    return r.changes as number;
  }

  /** Decided approvals only, most recent first, the audit trail's read side. No client-facing
   *  filtering yet (by session/tool/date range); direct sqlite3 access covers that for now. */
  queryRecentApprovals(limit = 50): ApprovalHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT tool_use_id, session_id, tool_name, description, requested_at, decision, reason, decided_by, decided_at
       FROM approvals WHERE decision IS NOT NULL ORDER BY decided_at DESC LIMIT ?`,
    ).all(limit) as any[];
    return rows.map((r) => ({
      toolUseId: r.tool_use_id,
      sessionId: r.session_id,
      toolName: r.tool_name,
      description: r.description ?? undefined,
      requestedAt: r.requested_at,
      decision: r.decision,
      reason: r.reason,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
    }));
  }

  // --- push registrations ---------------------------------------------------------------------
  //
  // Upsert, not DO NOTHING (the opposite of recordApprovalRequested): a device rotating its Expo
  // token must overwrite the old one, or pushes would go to a dead token forever. Keyed by device,
  // so one row per device and revoke drops it.

  upsertPushRegistration(deviceId: string, token: string, platform: PushPlatform, at: number) {
    this.db.prepare(
      `INSERT INTO push_registrations (device_id, token, platform, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, platform = excluded.platform, updated_at = excluded.updated_at`,
    ).run(deviceId, token, platform, at);
  }

  /** Every registered push token, the fan-out target for an approval wake ping. */
  listPushTokens(): string[] {
    return (this.db.prepare(`SELECT token FROM push_registrations`).all() as any[]).map((r) => r.token);
  }

  deletePushRegistration(deviceId: string) {
    this.db.prepare(`DELETE FROM push_registrations WHERE device_id = ?`).run(deviceId);
  }

  close() {
    this.db.close();
  }
}
