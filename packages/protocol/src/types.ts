// Protocol shared by daemon, CLI client, and eventually the React Native app.

export type SessionState =
  /** Process spawned, not yet confirmed alive. Transient. */
  | 'starting'
  /**
   * Alive and accepting input, but never used. A headless session emits no
   * `system/init` until it receives its first message (verified:
   * tests/integration/init_and_failclosed.py), so it has no claudeSessionId
   * or model yet. Distinct from `idle`, which means "has run and is now waiting".
   */
  | 'ready'
  | 'working'
  | 'waiting_approval'
  | 'waiting_input'
  | 'idle'
  | 'finished'
  | 'errored';

export interface SessionInfo {
  /** Daemon-assigned, stable across Claude Code session id changes (fork/resume). */
  id: string;
  /** Claude Code's own session id, from the system/init event. */
  claudeSessionId: string | null;
  cwd: string;
  label: string;
  state: SessionState;
  model: string | null;
  startedAt: number;
  lastActivityAt: number;
  pendingApprovals: number;
}

/** A tool call blocked on a human decision. */
export interface PendingApproval {
  /** Claude Code's tool_use_id, the correlation key. */
  toolUseId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Model-written summary, present on Bash. Better headline than the raw command. */
  description?: string;
  requestedAt: number;
  /** Absolute deadline. After this the bridge self-denies, so the UI must show it. */
  deadlineAt: number;
  /** Set once decided; late deciders lose the compare-and-swap. */
  decision?: { decision: 'allow' | 'deny'; reason: string; by: string; at: number };
}

/** A decided approval read back from the durable store, the audit trail's read side. */
export interface ApprovalHistoryEntry {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  description?: string;
  requestedAt: number;
  decision: 'allow' | 'deny';
  reason: string;
  decidedBy: string;
  decidedAt: number;
}

export type JobState = 'queued' | 'running' | 'done' | 'failed';

/**
 * A `claude` reasoning-effort level (`--effort`, or the `/effort` slash command mid-session).
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A `claude --permission-mode` value.
 *
 * The daemon's whole purpose is to gate tool calls through remote approval, which rests on the
 * approve-bridge PreToolUse hook firing. `plan` keeps that intact (the agent plans, and any tool it
 * proposes still blocks for approval). The auto-approving modes (`acceptEdits`, `auto`,
 * `bypassPermissions`, `dontAsk`) can let a tool run without a remote decision, which is exactly the
 * guarantee this daemon exists to provide, so the daemon is deliberately restrictive about them
 * (see the spawn/set handlers). Omitting the mode entirely uses `claude`'s own default.
 */
export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

/** The mobile platform a device registers a push token for. */
export type PushPlatform = 'ios' | 'android';

export interface JobInfo {
  id: string;
  cwd: string;
  label?: string;
  disallowedTools?: string[];
  /** Per-session launch config (model / permission mode / effort). Carried in-memory to the spawn
   *  and broadcast on the live job_update; deliberately NOT persisted (it only matters at launch, and
   *  keeping it off the jobs schema avoids a migration on existing daemon databases). */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  state: JobState;
  sessionId?: string;
  error?: string;
  requestedBy: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** Events fanned out to every connected client. */
export type ServerEvent =
  | { type: 'session_list'; sessions: SessionInfo[] }
  | { type: 'session_update'; session: SessionInfo }
  | { type: 'approval_pending'; approval: PendingApproval }
  | { type: 'approval_resolved'; toolUseId: string; decision: 'allow' | 'deny'; by: string }
  | { type: 'stream'; sessionId: string; event: unknown }
  | { type: 'error'; message: string }
  | { type: 'job_update'; job: JobInfo }
  | { type: 'revoked'; deviceId: string }
  | { type: 'approval_history'; approvals: ApprovalHistoryEntry[] }
  /** Cumulative ack: the daemon has processed every client→daemon command up to and including
   *  `upTo`. Lets a client drop acked commands from its resend buffer. Transport control, not
   *  data, clients never render it. Sealed like every post-hello frame. */
  | { type: 'ack'; upTo: number };

export type ClientCommand =
  | { type: 'list' }
  | { type: 'history'; limit?: number }
  | { type: 'spawn'; cwd: string; label?: string; disallowedTools?: string[]; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'set_model'; sessionId: string; model: string }
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionMode }
  | { type: 'decide'; toolUseId: string; decision: 'allow' | 'deny'; reason?: string; by: string }
  | { type: 'revoke'; deviceId: string }
  /** Register (or rotate) this device's push token, so the daemon can wake it when a tool call needs
   *  a decision. Sealed like every post-hello command, the token never crosses the wire in plaintext. */
  | { type: 'register_push'; token: string; platform: PushPlatform };

/**
 * Pre-auth handshake on the client socket. Plaintext by necessity: this is how trust
 * gets established in the first place. `begin_pair`/`complete_pair` mirror QR-code pairing:
 * physical possession of the one-time secret is the authentication. `hello` starts a session
 * for an already-paired device; everything after `session_salt` is a SealedFrame wrapping a
 * ClientCommand or ServerEvent, never plaintext.
 */
export type UnauthClientMessage =
  | { type: 'begin_pair' }
  | { type: 'complete_pair'; devicePublicKey: string; deviceName: string; proof: string }
  /** `lastSeq` optional: omitted on a first-ever hello, present on a reconnect asking to resume. */
  | { type: 'hello'; deviceId: string; lastSeq?: number };

export type UnauthServerMessage =
  | { type: 'pair_qr'; qr: string; expiresAt: number }
  | { type: 'paired'; deviceId: string; daemonPublicKey: string }
  | { type: 'pair_failed' }
  /**
   * `resumed: true` means what follows is replayed events at their original seq, not a fresh
   * session_list. `replayedCount` is informational only, the client learns the live seq purely
   * by observing `frame.seq` on events it actually receives, no separate echo field needed.
   */
  | { type: 'session_salt'; salt: string; resumed: boolean; replayedCount?: number }
  | { type: 'hello_failed' };
