import type { SessionState } from '@claudecode/protocol';

/**
 * Map one Claude stream-json event to the session state it implies, or null if the event does not
 * change the state.
 *
 * These are the product's user-visible session states (typed signals, strictly better than
 * scraping terminal output). Extracted from Session as a pure, side-effect-free function so the
 * mapping is unit-testable over plain event objects instead of only through a spawned `claude` child
 *, the same discipline the hook-margin rule and mergeSnapshotJobs already follow. Session owns the
 * I/O (spawn, stdout framing, stdin writes) and the actual setState transition; this owns only the
 * translation from Claude's event shapes to a SessionState.
 */
export function deriveSessionState(ev: any): SessionState | null {
  if (ev?.type === 'system' && ev.subtype === 'init') return 'idle';
  if (ev?.type === 'system' && ev.subtype === 'notification') {
    switch (ev.notification_type) {
      case 'permission_prompt': return 'waiting_approval';
      case 'agent_needs_input':
      case 'idle_prompt': return 'waiting_input';
      case 'agent_completed': return 'idle';
      default: return null;
    }
  }
  if (ev?.type === 'assistant') return 'working';
  if (ev?.type === 'result') return 'idle';
  return null;
}
