// render.ts is the CLI's trust boundary: daemon/peer-controlled fields (a session label, a tool name,
// a decision reason) are printed into a record a human reads, so an embedded newline or ANSI escape
// must be neutralized or it could forge a line or drive the terminal. These tests exist because that
// logic used to be trapped in the socket entry point where it could not be reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerEvent } from '@claude-code-remote/protocol';
import { safe, render } from '../src/render.ts';

test('safe() strips control characters that could forge a line or drive the terminal', () => {
  const cleaned = safe('ok\r\nFORGED\x1b[31m\x07');
  assert.ok(!cleaned.includes('\n'), 'newline removed');
  assert.ok(!cleaned.includes('\r'), 'carriage return removed');
  assert.ok(!cleaned.includes('\x1b'), 'ESC removed');
  assert.ok(!cleaned.includes('\x07'), 'BEL removed');
  assert.ok(cleaned.includes('ok') && cleaned.includes('FORGED'), 'printable content is kept');
});

test('safe() renders null and undefined as empty, never throws', () => {
  assert.equal(safe(undefined), '');
  assert.equal(safe(null), '');
});

test('render() neutralizes an untrusted session label before printing it', () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    const ev: ServerEvent = {
      type: 'session_update',
      session: {
        id: 'abcdef123456', claudeSessionId: null, cwd: '/w', label: 'evil\x1b[2Jlabel',
        state: 'working', model: null, startedAt: 0, lastActivityAt: 0, pendingApprovals: 0,
      },
    };
    render(ev);
  } finally {
    console.log = orig;
  }
  const out = lines.join('\n');
  assert.ok(out.includes('evil'), 'the label text is still shown');
  assert.ok(!out.includes('\x1b'), 'the embedded escape was neutralized before printing');
});
