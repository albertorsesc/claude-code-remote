// The UI formatters are pure and branch-heavy (documented thresholds), so their boundaries are the
// cheapest thing to protect against off-by-one drift that would silently render wrong labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown, formatRelative, firstLine, shortId } from './format.ts';

test('formatCountdown clamps negatives, pads seconds, and rolls minutes', () => {
  assert.equal(formatCountdown(-1), '0:00', 'a passed deadline never shows negative time');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(9_000), '0:09', 'seconds are zero-padded');
  assert.equal(formatCountdown(65_000), '1:05');
  assert.equal(formatCountdown(600_000), '10:00');
});

test('formatRelative crosses each threshold correctly', () => {
  const now = 1_000_000_000;
  const ago = (ms: number) => formatRelative(now - ms, now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(4_999), 'just now', 'under 5s is "just now"');
  assert.equal(ago(5_000), '5s ago', 'at 5s it switches to seconds');
  assert.equal(ago(59_000), '59s ago');
  assert.equal(ago(60_000), '1m ago', 'at 60s it switches to minutes');
  assert.equal(ago(59 * 60_000), '59m ago');
  assert.equal(ago(60 * 60_000), '1h ago', 'at 60m it switches to hours');
  assert.equal(ago(23 * 3_600_000), '23h ago');
  assert.equal(ago(24 * 3_600_000), '1d ago', 'at 24h it switches to days');
  assert.equal(formatRelative(now + 5_000, now), 'just now', 'a future timestamp clamps to "just now"');
});

test('firstLine returns the first non-empty trimmed line', () => {
  assert.equal(firstLine('hello'), 'hello');
  assert.equal(firstLine('\n\n  rm -rf node_modules\nnpm ci'), 'rm -rf node_modules', 'leading blanks skipped');
  assert.equal(firstLine('   \n  \n'), '', 'all-blank input trims to empty');
});

test('shortId truncates only past its length', () => {
  assert.equal(shortId('abc'), 'abc', 'shorter than the cap is returned whole');
  assert.equal(shortId('a1b2c3d4e5f6'), 'a1b2c3d4', 'default cap is 8');
  assert.equal(shortId('a1b2c3d4e5f6', 4), 'a1b2', 'a custom cap is honored');
});
