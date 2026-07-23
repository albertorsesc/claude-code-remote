// InboundStream prunes old seqs for bounded memory, so a duplicate arriving
// far outside the window is ACCEPTED. This is a deliberate, documented tradeoff
// (documented in the README security model), safe because ApprovalBroker
// compare-and-swaps on toolUseId, so a re-accepted duplicate still cannot double-decide.
// This test characterizes the boundary so a silent change to the window size is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundStream } from '@claude-code-remote/protocol';

test('immediate duplicate is rejected', () => {
  const inb = new InboundStream();
  inb.accept(1);
  assert.equal(inb.accept(1), false);
});

test('duplicate re-accepted once it falls outside the prune window', () => {
  const inb = new InboundStream();
  inb.accept(1);
  for (let i = 2; i <= 6000; i++) inb.accept(i);
  assert.equal(inb.accept(1), true, 'dup of seq 1 should be outside the ~6000-seq window by now');
});

test('dedup window is bounded (not unbounded, not trivially small)', () => {
  // Scanned DOWNWARD from the newest seq on purpose. The previous version scanned upward from 1
  // and stopped at the first re-accept, which is essentially always seq 1, the OLDEST forgotten
  // one, so `windowSize` computed to ~5999 no matter how small the real window was. A window of
  // 10 would have passed a test whose message claims to catch exactly that. Walking down from the
  // newest measures the run of seqs still remembered, which is the actual quantity of interest.
  //
  // Probing is non-destructive while it stays inside the window: accept() returns false and
  // changes nothing for a seq already known. The first `true` means we walked off the end, so the
  // loop breaks immediately and the one mutation it causes never affects the measurement.
  const probe = new InboundStream();
  for (let i = 1; i <= 6000; i++) probe.accept(i);

  let oldestRemembered = 6001;
  for (let i = 6000; i >= 1; i--) {
    if (probe.accept(i)) break;   // i had been pruned, the window ends just above it
    oldestRemembered = i;
  }

  assert.ok(oldestRemembered > 1, 'window appears unbounded, every seq back to 1 was still remembered');
  const windowSize = 6000 - oldestRemembered + 1;
  assert.ok(windowSize > 100, `dedup window suspiciously small: ${windowSize} seq(s)`);
  // The client's resend buffer caps at 256, so every resendable command must still be inside this
  // window or a legitimate resend would be re-executed instead of deduped.
  assert.ok(windowSize > 256,
    `dedup window (${windowSize}) must exceed the client's 256-command resend buffer, or a ` +
    'resent command could fall outside it and be executed twice');
});
