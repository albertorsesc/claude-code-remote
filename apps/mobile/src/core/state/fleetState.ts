/**
 * The pure view-state of the app: what the screens render. It is a fold over the daemon's ServerEvent
 * stream, kept as a plain reducer (no React, no zustand) so the state transitions are unit-testable
 * without a running app. The store binds this to the UI; the reducer is where the logic lives.
 */
import type {
  ServerEvent, SessionInfo, PendingApproval, JobInfo, ApprovalHistoryEntry,
} from '@claude-code-remote/protocol';

/** How many stream (transcript) events to keep per session, so an unbounded stream cannot grow memory. */
const MAX_TRANSCRIPT = 200;

export interface FleetState {
  /** Live sessions, keyed by daemon session id. */
  sessions: Record<string, SessionInfo>;
  /** Pending tool-call approvals, keyed by toolUseId. Removed once resolved. */
  approvals: Record<string, PendingApproval>;
  /** Spawn jobs, keyed by job id. */
  jobs: Record<string, JobInfo>;
  /** Per-session transcript events (bounded), keyed by session id. */
  transcripts: Record<string, unknown[]>;
  /** The durable approval decision history, when loaded via a `history` command. */
  history: ApprovalHistoryEntry[];
  /** The last error the daemon reported, for a transient banner. */
  lastError: string | null;
}

export const emptyFleetState: FleetState = {
  sessions: {}, approvals: {}, jobs: {}, transcripts: {}, history: [], lastError: null,
};

/** Apply one authenticated ServerEvent to the state, returning a new state (never mutating). */
export function applyEvent(state: FleetState, event: ServerEvent): FleetState {
  switch (event.type) {
    case 'session_list':
      return { ...state, sessions: Object.fromEntries(event.sessions.map((s) => [s.id, s])) };

    case 'session_update':
      return { ...state, sessions: { ...state.sessions, [event.session.id]: event.session } };

    case 'approval_pending':
      return { ...state, approvals: { ...state.approvals, [event.approval.toolUseId]: event.approval } };

    case 'approval_resolved': {
      const approvals = { ...state.approvals };
      delete approvals[event.toolUseId];
      return { ...state, approvals };
    }

    case 'job_update':
      return { ...state, jobs: { ...state.jobs, [event.job.id]: event.job } };

    case 'stream': {
      const prev = state.transcripts[event.sessionId] ?? [];
      const next = [...prev, event.event].slice(-MAX_TRANSCRIPT);
      return { ...state, transcripts: { ...state.transcripts, [event.sessionId]: next } };
    }

    case 'approval_history':
      return { ...state, history: event.approvals };

    case 'error':
      return { ...state, lastError: event.message };

    case 'revoked':
      // Handled by the connection layer (it tears down when our own device is revoked); the view
      // state has nothing to change.
      return state;

    case 'ack':
      // Transport control, swallowed by the client engine before it reaches here; ignore defensively.
      return state;
  }
}

// --- selectors (derived views the screens use) --------------------------------------------------

/** Sessions as an array, most recently active first. */
export function sessionList(state: FleetState): SessionInfo[] {
  return Object.values(state.sessions).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Pending approvals as an array, soonest deadline first. */
export function pendingApprovals(state: FleetState): PendingApproval[] {
  return Object.values(state.approvals).sort((a, b) => a.deadlineAt - b.deadlineAt);
}

/** Count of pending approvals, for a badge. */
export function pendingCount(state: FleetState): number {
  return Object.keys(state.approvals).length;
}
