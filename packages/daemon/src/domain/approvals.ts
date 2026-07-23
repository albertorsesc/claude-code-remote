import { EventEmitter } from 'node:events';
import type { PendingApproval } from '@claudecode/protocol';

interface Waiter {
  respond: (decision: 'allow' | 'deny', reason: string) => void;
}

/**
 * Single arbiter for approvals across every client, so two clients cannot decide the same tool call.
 *
 * Race-freedom comes from the shape of the problem, not from locking: exactly one
 * blocked hook consumes exactly one answer, so a compare-and-swap on toolUseId is
 * sufficient. First decision wins; late deciders are told who beat them.
 */
export class ApprovalBroker extends EventEmitter {
  private pending = new Map<string, PendingApproval>();
  private waiters = new Map<string, Waiter>();

  /**
   * Claim a toolUseId for the first request that presents it. Returns false if this toolUseId is
   * already tracked (a live pending request, or one decided within the retention window).
   *
   * First-writer-wins, matching the durable side (db.recordApprovalRequested uses ON CONFLICT DO
   * NOTHING). Overwriting unconditionally let a second, unauthenticated hook socket replace the
   * operator-visible content AND the waiter that receives the decision: the phone showed a benign
   * `Read` while the audit row still held the original `rm -rf`, and re-opening a decided id cleared
   * `decision`, defeating the compare-and-swap. The caller must fail the rejected duplicate closed.
   */
  open(approval: PendingApproval, waiter: Waiter): boolean {
    if (this.pending.has(approval.toolUseId)) return false;
    this.pending.set(approval.toolUseId, approval);
    this.waiters.set(approval.toolUseId, waiter);
    this.emit('pending', approval);
    return true;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].filter((a) => !a.decision);
  }

  get(toolUseId: string) {
    return this.pending.get(toolUseId);
  }

  /**
   * @returns 'ok' if this decision won, 'already' if someone beat it, 'unknown' if no such request.
   */
  decide(
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason: string,
    by: string,
  ): 'ok' | 'already' | 'unknown' {
    const approval = this.pending.get(toolUseId);
    if (!approval) return 'unknown';
    if (approval.decision) return 'already'; // compare-and-swap loser

    approval.decision = { decision, reason, by, at: Date.now() };
    const waiter = this.waiters.get(toolUseId);
    this.waiters.delete(toolUseId);
    waiter?.respond(decision, reason);
    this.emit('resolved', approval);

    // Keep briefly so a late client gets 'already' rather than 'unknown'.
    setTimeout(() => this.pending.delete(toolUseId), 60_000).unref?.();
    return 'ok';
  }

  /** Hook vanished (session died, bridge killed). Deny it; the bridge denies on its own side too. */
  abandon(toolUseId: string) {
    const a = this.pending.get(toolUseId);
    // Only touch the waiter for an entry that is present AND still undecided: reading/deleting it
    // unconditionally could act on a DIFFERENT approval that reused this toolUseId after the first
    // aged out of `pending`, denying a request this socket never claimed.
    if (a && !a.decision) {
      const waiter = this.waiters.get(toolUseId);
      this.waiters.delete(toolUseId);
      a.decision = { decision: 'deny', reason: 'request abandoned', by: 'daemon', at: Date.now() };
      // Invoke the waiter, exactly as decide() does. Its respond callback is the ONLY code that
      // clears the owning session's pendingApprovals set and broadcasts the corrected count,
      // deleting the waiter without calling it (the old behaviour) stranded that id in the set
      // forever, so a session with nothing pending rendered a phantom '(N pending)' on every client.
      waiter?.respond('deny', 'request abandoned');
      this.emit('resolved', a);
      // Age the entry out, mirroring decide(): a late client gets 'already' not 'unknown', then it
      // is dropped so `pending` does not grow one retained entry per abandoned approval for the
      // process lifetime.
      setTimeout(() => this.pending.delete(toolUseId), 60_000).unref?.();
    }
  }
}
