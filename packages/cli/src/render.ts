/**
 * The terminal display layer for `cc`: turns a ServerEvent into printed lines. Pure of sockets and
 * process state, so it can be unit-tested, which matters because `safe()` is a trust boundary. The
 * fleet view and the `cc history` audit trail are a trust record whose fields (a session label, a
 * tool name, an approval `by`, a decision `reason`) are controlled by an authenticated-but-untrusted
 * peer; an embedded newline or ANSI escape would otherwise forge a line or drive the reviewing
 * terminal. Every such field goes through the shared neutralizer before printing.
 */
import { neutralizeControlChars, type ServerEvent } from '@claude-code-remote/protocol';

const ago = (t: number) => `${Math.round((Date.now() - t) / 1000)}s ago`;
const left = (t: number) => `${Math.max(0, Math.round((t - Date.now()) / 60000))}m left`;

/** Neutralize control characters in any daemon/session-supplied string before printing it. */
export const safe = (v: unknown): string => neutralizeControlChars(String(v ?? ''));

const BADGE: Record<string, string> = {
  waiting_approval: 'NEEDS YOU',
  waiting_input: 'NEEDS YOU',
  working: 'working',
  idle: 'idle',
  finished: 'done',
  errored: 'ERROR',
  starting: 'starting',
  ready: 'ready',
};

export function render(ev: ServerEvent): void {
  switch (ev.type) {
    case 'session_list':
      if (!ev.sessions.length) { console.log('(no sessions)'); break; }
      console.log('\nSESSIONS');
      for (const s of ev.sessions) {
        console.log(`  ${(BADGE[s.state] ?? safe(s.state)).padEnd(10)} ${safe(s.label).padEnd(18)} ${s.id.slice(0, 8)}  ${ago(s.lastActivityAt)}`);
      }
      break;
    case 'session_update': {
      const s = ev.session;
      console.log(`[session] ${(BADGE[s.state] ?? safe(s.state)).padEnd(10)} ${safe(s.label)} ${s.id.slice(0, 8)}` +
        (s.pendingApprovals ? `  (${s.pendingApprovals} pending)` : ''));
      break;
    }
    case 'approval_pending': {
      const a = ev.approval;
      const detail = a.toolInput?.command ?? a.toolInput?.file_path ?? '';
      console.log(`\n  APPROVAL NEEDED  ${safe(a.toolName)}  [${left(a.deadlineAt)}]`);
      if (a.description) console.log(`     ${safe(a.description)}`);
      if (detail) console.log(`     ${safe(detail).slice(0, 120)}`);
      console.log(`     cc allow ${safe(a.toolUseId)}   |   cc deny ${safe(a.toolUseId)} "reason"\n`);
      break;
    }
    case 'approval_resolved':
      console.log(`  resolved ${safe(ev.toolUseId).slice(0, 16)} -> ${safe(ev.decision)} by ${safe(ev.by)}`);
      break;
    case 'job_update': {
      const j = ev.job;
      console.log(`[job] ${safe(j.state).padEnd(8)} ${safe(j.label ?? j.cwd)}` + (j.error ? `  ${safe(j.error)}` : ''));
      break;
    }
    case 'revoked':
      console.log(`  revoked device ${safe(ev.deviceId)}`);
      break;
    case 'approval_history': {
      if (!ev.approvals.length) { console.log('(no decided approvals yet)'); break; }
      console.log('\nAPPROVAL HISTORY (most recent first)');
      for (const a of ev.approvals) {
        const when = new Date(a.decidedAt).toISOString().slice(0, 19).replace('T', ' ');
        console.log(`  ${when}  ${safe(a.decision).toUpperCase().padEnd(5)} ${safe(a.toolName).padEnd(10)} ${safe(a.decidedBy)}` +
          (a.reason ? `  "${safe(a.reason)}"` : ''));
      }
      break;
    }
    case 'error':
      console.error(`  error: ${safe(ev.message)}`);
      break;
  }
}
