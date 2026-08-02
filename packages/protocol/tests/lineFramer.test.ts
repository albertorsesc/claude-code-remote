import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineFramer } from '../src/lineFramer.ts';

test('emits complete lines in order and skips blank ones', () => {
  const lines: string[] = [];
  const f = new LineFramer({ onLine: (l) => lines.push(l) });
  f.push('a\n\n  \nb\nc\n');
  assert.deepEqual(lines, ['a', 'b', 'c'], 'blank and whitespace-only lines are dropped');
});

test('reassembles a line split across chunks', () => {
  const lines: string[] = [];
  const f = new LineFramer({ onLine: (l) => lines.push(l) });
  f.push('hel');
  f.push('lo wor');
  f.push('ld\nnext\n');
  assert.deepEqual(lines, ['hello world', 'next']);
});

test('holds an unterminated partial until its newline arrives', () => {
  const lines: string[] = [];
  const f = new LineFramer({ onLine: (l) => lines.push(l) });
  f.push('partial');
  assert.deepEqual(lines, [], 'no newline yet, nothing emitted');
  f.push('\n');
  assert.deepEqual(lines, ['partial']);
});

test('drops the peer and clears the buffer when a fixed cap is exceeded', () => {
  const lines: string[] = [];
  let overflow: { buffered: number; cap: number } | null = null;
  const f = new LineFramer({
    onLine: (l) => lines.push(l),
    maxBytes: 8,
    onOverflow: (buffered, cap) => { overflow = { buffered, cap }; },
  });
  f.push('123456789'); // 9 bytes, no newline, over the cap of 8
  assert.deepEqual(lines, [], 'nothing is emitted from an over-cap buffer');
  assert.deepEqual(overflow, { buffered: 9, cap: 8 });
  // After overflow the buffer is cleared, so a subsequent well-formed line still frames.
  f.push('ok\n');
  assert.deepEqual(lines, ['ok']);
});

test('a dynamic cap is evaluated per push (auth-vs-unauth style)', () => {
  const lines: string[] = [];
  let authed = false;
  let overflowed = false;
  const f = new LineFramer({
    onLine: (l) => lines.push(l),
    maxBytes: () => (authed ? 100 : 4),
    onOverflow: () => { overflowed = true; },
  });
  authed = true;
  f.push('longer-than-four-but-under-hundred\n');
  assert.deepEqual(lines, ['longer-than-four-but-under-hundred'], 'allowed while the cap is high');
  assert.equal(overflowed, false);
  authed = false;
  f.push('toolong'); // 7 bytes, cap now 4
  assert.equal(overflowed, true, 'the same framer trips once the cap drops');
});

test('reset discards a buffered partial line', () => {
  const lines: string[] = [];
  const f = new LineFramer({ onLine: (l) => lines.push(l) });
  f.push('half');
  f.reset();
  f.push('done\n');
  assert.deepEqual(lines, ['done'], 'the pre-reset partial did not leak into the next line');
});
