// The shared control-char neutralizer, used by BOTH trust records: the daemon operator log
// (createLogger) and the CLI's rendered audit trail (`cc history`). Binding it in one place is what
// keeps the two records' guarantee identical, so this is where the guarantee is proven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeControlChars } from '@claudecode/protocol';

test('a newline cannot forge a second line', () => {
  const forged = 'attacker/cli\n  2099-01-01 00:00:00  ALLOW Bash trusted-admin/cli';
  const out = neutralizeControlChars(forged);
  assert.ok(!out.includes('\n'), 'no real newline survives');
  assert.ok(out.includes('\\n'), 'it becomes a visible escape instead');
});

test('the ANSI escape (ESC 0x1b) is neutralized, blocking terminal manipulation', () => {
  const ansi = '\x1b[2K\x1b[A'; // erase-line + cursor-up: used to overwrite a prior rendered row
  const out = neutralizeControlChars(ansi);
  assert.ok(!out.includes('\x1b'), 'no raw ESC survives');
  assert.equal(out, '\\x1b[2K\\x1b[A', 'ESC becomes \\x1b');
});

test('CR, NUL, and DEL are escaped; tab and normal text are preserved', () => {
  assert.equal(neutralizeControlChars('a\rb'), 'a\\rb', 'CR -> \\r');
  assert.equal(neutralizeControlChars('a\x00b'), 'a\\x00b', 'NUL -> \\x00');
  assert.equal(neutralizeControlChars('a\x7fb'), 'a\\x7fb', 'DEL -> \\x7f');
  assert.equal(neutralizeControlChars('a\tb'), 'a\tb', 'tab is left literal');
  assert.equal(neutralizeControlChars('normal text 123 /path/to.ts'), 'normal text 123 /path/to.ts');
});

test('multibyte / non-control characters pass through untouched', () => {
  assert.equal(neutralizeControlChars('café, 日本語 😀'), 'café, 日本語 😀');
});
