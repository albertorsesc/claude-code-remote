// the operator log is an append-only trust record, and some call sites interpolate
// UNAUTHENTICATED peer input (e.g. an unknown deviceId at the client handshake). A newline embedded
// in that input must not be able to forge whole log lines. createLogger escapes control characters
// in string args before they reach the sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/infrastructure/logger.ts';

function capturingLogger() {
  const lines: string[] = [];
  // Mirror console.log's join-with-space behaviour so we assert on what a real sink would print.
  const log = createLogger((...a: unknown[]) => lines.push(a.join(' ')));
  return { log, lines };
}

test('a newline in an interpolated value cannot forge a second log line', () => {
  const { log, lines } = capturingLogger();
  const forged = 'deadbeef\nWARN paired device 9f2c1a (attacker-phone)\ndecision allow by 9f2c1a (admin)';
  log(`hello rejected: unknown deviceId ${forged}`);

  assert.equal(lines.length, 1, 'the whole call is a single sink write');
  assert.ok(!lines[0].includes('\n'), 'no real newline survives into the operator log');
  assert.ok(lines[0].includes('\\n'), 'the injected newline is shown as a visible escape instead');
  // The forged text is neutralised: it can no longer masquerade as its own line.
  assert.match(lines[0], /unknown deviceId deadbeef\\nWARN paired device/);
});

test('carriage return and other C0 controls are escaped; tab and normal text are preserved', () => {
  const { log, lines } = capturingLogger();
  log('a\rb\x00c\tdate=', 'ok');
  assert.ok(lines[0].includes('a\\rb'), 'CR becomes \\r');
  assert.ok(lines[0].includes('\\x00'), 'NUL becomes \\x00');
  assert.ok(lines[0].includes('c\td'), 'tab is left literal');
  assert.ok(lines[0].endsWith('ok'), 'later args still print');
});

test('non-string args pass through untouched (structured logging is unaffected)', () => {
  const captured: unknown[][] = [];
  const log = createLogger((...a: unknown[]) => captured.push(a));
  const obj = { deviceId: 'x', count: 3 };
  log('event', obj, 42);
  // args after the timestamp: 'event', the SAME object reference, 42
  assert.equal(captured[0][2], obj, 'the object is not stringified or cloned');
  assert.equal(captured[0][3], 42);
});
