// The hook-margin safety rule, tested as a pure function.
//
// This rule decides whether spawning a session is safe: if a project's PreToolUse hook `timeout`
// is not comfortably larger than the bridge's self-deny, the runtime can kill the bridge
// mid-decision and the tool call executes UNGUARDED. It is the single most safety-critical
// predicate in the daemon.
//
// Until it was extracted from jobs.ts it needed a temp directory and a real settings.json to
// exercise even once, so the edge cases below were effectively untested. They are the cases that
// actually matter, boundaries, competing hooks, and malformed input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHookMargin, MIN_MARGIN_MS } from '../src/domain/hookMargin.ts';

const SELF_DENY = 1_200_000; // 20 min, the daemon's default

/** settings.json shape with a single approve-bridge hook at `timeoutSeconds`. */
function settingsWith(timeoutSeconds: unknown, command = '/usr/bin/env node /x/hook/approve-bridge.mjs') {
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: timeoutSeconds }] }] } };
}

test('accepts a generous margin', () => {
  const r = evaluateHookMargin(settingsWith(1800), SELF_DENY, 'settings.json');
  assert.equal(r.ok, true);
});

test('refuses when no PreToolUse hook runs approve-bridge at all', () => {
  const r = evaluateHookMargin({ hooks: { PreToolUse: [] } }, SELF_DENY, 'x/settings.json');
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /no PreToolUse hook running approve-bridge\.mjs in x\/settings\.json/);
});

test('refuses when a hook exists but is a different command', () => {
  const r = evaluateHookMargin(settingsWith(1800, 'node some-other-hook.mjs'), SELF_DENY, 'settings.json');
  assert.equal(r.ok, false);
});

test('refuses when the approve-bridge hook has no usable numeric timeout', () => {
  // A missing or non-numeric timeout means the runtime default applies, which we cannot reason about.
  const cases: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['string', '1800'],
    ['object', {}],
    // The one that actually regressed: typeof NaN === 'number', so NaN passed the old guard and
    // made the margin arithmetic NaN, which compares false against the minimum and returned
    // ok:true, the safety check failing OPEN. Same for the infinities.
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];
  for (const [label, bad] of cases) {
    const r = evaluateHookMargin(settingsWith(bad), SELF_DENY, 'settings.json');
    assert.equal(r.ok, false, `timeout=${label} must be refused, never silently accepted`);
  }
});

// --- the boundary, in both directions ---

test('accepts exactly at the minimum margin (inclusive boundary)', () => {
  const timeoutSeconds = (SELF_DENY + MIN_MARGIN_MS) / 1000;
  const r = evaluateHookMargin(settingsWith(timeoutSeconds), SELF_DENY, 'settings.json');
  assert.equal(r.ok, true, 'a margin of exactly MIN_MARGIN_MS is safe');
});

test('refuses one millisecond below the minimum margin', () => {
  const timeoutSeconds = (SELF_DENY + MIN_MARGIN_MS - 1) / 1000;
  const r = evaluateHookMargin(settingsWith(timeoutSeconds), SELF_DENY, 'settings.json');
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /need at least 30000ms/);
});

test('refuses a negative margin (timeout shorter than self-deny)', () => {
  const r = evaluateHookMargin(settingsWith(60), SELF_DENY, 'settings.json');
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /-1140000ms of margin/);
});

// --- the case that actually bites: several hooks, one of them tight ---

test('the SMALLEST timeout governs when multiple approve-bridge hooks exist', () => {
  // Whichever hook fires first can kill the bridge, so one tight entry makes the project unsafe
  // no matter how generous its siblings are. Taking a max (or the first) here would silently
  // approve a project that can execute tools unguarded.
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'approve-bridge.mjs', timeout: 1800 }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'approve-bridge.mjs', timeout: 60 }] },
      ],
    },
  };
  const r = evaluateHookMargin(settings, SELF_DENY, 'settings.json');
  assert.equal(r.ok, false, 'a single tight hook must refuse the whole project');
});

// --- malformed input must refuse, never throw ---

test('malformed settings refuse rather than throwing', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    42,
    'not an object',
    {},
    { hooks: null },
    { hooks: { PreToolUse: null } },
    { hooks: { PreToolUse: [null] } },
    { hooks: { PreToolUse: [{ hooks: null }] } },
    { hooks: { PreToolUse: [{ hooks: [null] }] } },
  ];
  for (const settings of malformed) {
    let result;
    assert.doesNotThrow(() => { result = evaluateHookMargin(settings, SELF_DENY, 'settings.json'); },
      `must not throw on ${JSON.stringify(settings)}`);
    assert.equal((result as any).ok, false, `must refuse on ${JSON.stringify(settings)}`);
  }
});

test('fails closed: every refusal carries a reason a human can act on', () => {
  const r = evaluateHookMargin({}, SELF_DENY, 'my/settings.json');
  assert.equal(r.ok, false);
  assert.ok((r as any).reason.length > 10, 'a refusal with no explanation is not actionable');
});
