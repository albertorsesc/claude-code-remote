// The daemon exists to gate tools through remote approval, so it only applies permission modes that
// preserve that gate. `plan` is allowed; the auto-approving modes are refused (fail-closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionModeIsAllowed, permissionModeRefusal } from '../src/domain/permissionMode.ts';

test('plan is allowed (it preserves per-tool approval)', () => {
  assert.equal(permissionModeIsAllowed('plan'), true);
});

test('every auto-approving / unknown mode is refused', () => {
  for (const m of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk'] as const) {
    assert.equal(permissionModeIsAllowed(m), false, `${m} must be refused`);
  }
});

test('the refusal message names the mode and the allowed set', () => {
  const msg = permissionModeRefusal('bypassPermissions');
  assert.match(msg, /bypassPermissions/);
  assert.match(msg, /plan/);
  assert.match(msg, /remote approval/i);
});
