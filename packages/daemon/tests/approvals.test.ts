// the ApprovalBroker compare-and-swap second-net, now tested in isolation. Command
// redelivery relies on inbound dedup to stop a resent `decide` from reaching the broker twice;
// this is the independent backstop if dedup ever missed, a second decision can't double-apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../src/domain/approvals.ts';
import type { PendingApproval } from '@claudecode/protocol';

function pending(toolUseId: string): PendingApproval {
  return { toolUseId, sessionId: 's', toolName: 'Bash', toolInput: {}, requestedAt: 0, deadlineAt: 0 };
}

test('decide: first decision wins (ok), second is rejected (already), never double-applies', () => {
  const broker = new ApprovalBroker();
  let responded: string[] = [];
  broker.open(pending('tu1'), { respond: (d) => responded.push(d) });

  assert.equal(broker.decide('tu1', 'allow', 'first', 'alice'), 'ok');
  assert.equal(broker.decide('tu1', 'deny', 'second', 'bob'), 'already', 'the CAS loser is told it lost');
  assert.deepEqual(responded, ['allow'], 'the hook was answered exactly once, with the first decision');
  assert.equal(broker.get('tu1')!.decision!.by, 'alice', 'the decision is still the first one');
});

test('decide: an unknown toolUseId is reported, not silently accepted', () => {
  const broker = new ApprovalBroker();
  assert.equal(broker.decide('nope', 'allow', '', 'x'), 'unknown');
});

// --- abandon() must run the waiter's cleanup, not just drop it ---
//
// The waiter's respond callback (supplied by hookBridge) is the ONLY code that clears the owning
// session's pendingApprovals set. Deleting the waiter without invoking it left that id in the set
// forever, so a session with nothing pending rendered a phantom '(N pending)' on every client, and
// the set (and broker.pending) grew one entry per abandoned approval for the process lifetime.

test('abandon: invokes the waiter so the owning session cleanup actually runs', () => {
  const broker = new ApprovalBroker();
  const responded: Array<{ decision: string; reason: string }> = [];
  // Mirror hookBridge's real wiring: the respond callback clears the owning session's set.
  const ownerPendingApprovals = new Set<string>(['tu1']);
  broker.open(pending('tu1'), {
    respond: (decision, reason) => { responded.push({ decision, reason }); ownerPendingApprovals.delete('tu1'); },
  });

  broker.abandon('tu1');
  assert.deepEqual(responded, [{ decision: 'deny', reason: 'request abandoned' }],
    'abandon RUNS the waiter, it does not merely delete it');
  assert.equal(ownerPendingApprovals.size, 0, 'the session pending set was cleared, no phantom count');
  assert.equal(broker.list().length, 0, 'the abandoned approval is no longer pending');
});

test('abandon: sets the decision, so a later decide loses the compare-and-swap', () => {
  const broker = new ApprovalBroker();
  broker.open(pending('tu1'), { respond: () => {} });
  broker.abandon('tu1');
  assert.equal(broker.decide('tu1', 'allow', '', 'late'), 'already',
    'abandon decided it (deny); a later decision loses rather than double-applying');
});

test('abandon after a decision is a no-op, the waiter is never invoked twice', () => {
  const broker = new ApprovalBroker();
  const responded: string[] = [];
  broker.open(pending('tu1'), { respond: (d) => responded.push(d) });
  broker.decide('tu1', 'allow', '', 'op');
  broker.abandon('tu1'); // the bridge socket closes after the decision landed
  assert.deepEqual(responded, ['allow'], 'exactly one respond, abandon does not re-fire it');
});

// --- open() is claim-once: a second request cannot hijack a live toolUseId ---

test('open: a second open for a live toolUseId is rejected, not an overwrite', () => {
  const broker = new ApprovalBroker();
  const respondedA: string[] = [];
  const respondedB: string[] = [];
  const first: PendingApproval = { toolUseId: 'T', sessionId: 's', toolName: 'Bash', toolInput: { command: 'rm -rf ~/work' }, requestedAt: 0, deadlineAt: 0 };
  const second: PendingApproval = { toolUseId: 'T', sessionId: 's', toolName: 'Read', toolInput: { file_path: 'README.md' }, requestedAt: 0, deadlineAt: 0 };

  assert.equal(broker.open(first, { respond: (d) => respondedA.push(d) }), true, 'first claim wins');
  assert.equal(broker.open(second, { respond: (d) => respondedB.push(d) }), false, 'the second open is rejected');

  // The operator-visible content is still the FIRST request's, the benign Read never replaced it.
  assert.equal(broker.get('T')!.toolName, 'Bash');
  assert.deepEqual(broker.get('T')!.toolInput, { command: 'rm -rf ~/work' });

  // Deciding resolves the genuine first waiter, never the rejected duplicate's.
  assert.equal(broker.decide('T', 'allow', 'ok', 'op'), 'ok');
  assert.deepEqual(respondedA, ['allow'], 'the genuine first request received the decision');
  assert.deepEqual(respondedB, [], 'the rejected duplicate never receives a decision');
});

test('open: claim-once does not let a re-open reset an existing decision', () => {
  const broker = new ApprovalBroker();
  broker.open(pending('T'), { respond: () => {} });
  assert.equal(broker.decide('T', 'deny', 'first', 'op1'), 'ok');
  assert.equal(broker.open(pending('T'), { respond: () => {} }), false, 'a re-open of a decided id is rejected');
  assert.equal(broker.decide('T', 'allow', 'second', 'op2'), 'already', 'the id stays decided; the CAS is not reset');
  assert.equal(broker.get('T')!.decision!.by, 'op1', 'the original decision stands');
});
