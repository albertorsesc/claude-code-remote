/**
 * Wires a running session's lifecycle to the durable store and surfaces its stderr. Extracted from the
 * composition root so the state-to-db mapping and the stderr policy (skip blank, truncate untrusted
 * volume) can be unit-tested, rather than living inline in index.ts where no test reaches them.
 */
import type { Logger, SessionPersistenceStore } from './ports.ts';

/**
 * The subset of a running session this wiring reads and listens to. The infrastructure Session
 * conforms structurally, so persistence is testable against a plain EventEmitter fake.
 */
export interface PersistableSession {
  readonly id: string;
  readonly cwd: string;
  readonly label: string;
  readonly startedAt: number;
  readonly claudeSessionId: string | null;
  readonly model: string | null;
  readonly lastActivityAt: number;
  readonly state: string;
  on(event: 'state', listener: () => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'stderr', listener: (text: string) => void): void;
}

/** Max stderr characters kept per line: stderr is untrusted volume, not a log stream we control. */
const MAX_STDERR_CHARS = 500;

export function attachSessionPersistence(
  session: PersistableSession,
  store: SessionPersistenceStore,
  log: Logger,
): void {
  store.recordSessionStarted({ id: session.id, cwd: session.cwd, label: session.label, startedAt: session.startedAt });
  session.on('state', () => store.updateSessionActivity(session.id, session.claudeSessionId, session.model, session.lastActivityAt));
  session.on('exit', (code) => store.recordSessionEnded(session.id, session.state, code, Date.now()));
  // Without this everything a session writes to stderr is silently discarded, so a session that failed
  // to start, hit a rate limit, or died on a bad flag looks identical to one thinking quietly.
  session.on('stderr', (text) => {
    const line = text.trim();
    if (line) log(`session ${session.label} (${session.id}) stderr: ${line.slice(0, MAX_STDERR_CHARS)}`);
  });
}
