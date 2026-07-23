// send()/interrupt() on a session whose child has exited must not silently flip a
// terminal session back to 'working'. After the child exits its stdin is destroyed, so the write is
// a no-op, and the setState('working') that followed stranded the session as "working" forever,
// nothing can move it out, because the only transitions come from a stdout that will never arrive.
//
// Drives the REAL Session against a fake `claude` on PATH, so no API cost and no real model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Session } from '../src/infrastructure/session.ts';

/** Install a fake `claude` executable on PATH; returns a restore function. */
function fakeClaude(body: string): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fakeclaude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, body, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
  return { dir, restore: () => { process.env.PATH = prevPath; fs.rmSync(dir, { recursive: true, force: true }); } };
}

const PROJECT = os.tmpdir();
const opts = () => ({ cwd: PROJECT, socketPath: path.join(os.tmpdir(), `cc-unused-${randomUUID()}.sock`), selfDenyMs: 60000 });

test('send() on a terminal (exited) session does NOT flip it back to working', async () => {
  // A claude that exits immediately, so the session reaches a terminal state right away.
  const fake = fakeClaude('#!/bin/sh\nexit 0\n');
  try {
    const s = new Session(opts());
    await once(s, 'exit');
    assert.ok(s.state === 'finished' || s.state === 'errored', `expected terminal, got ${s.state}`);

    s.send('are you there?');
    assert.ok(s.state === 'finished' || s.state === 'errored',
      'send() must be a no-op on a dead session, never a flip to "working"');

    s.interrupt();
    assert.ok(s.state === 'finished' || s.state === 'errored', 'interrupt() is likewise a no-op when terminal');
  } finally {
    fake.restore();
  }
});

test('spawn passes --model / --permission-mode / --effort through to claude', async () => {
  const argvFile = path.join(os.tmpdir(), `cc-argv-${randomUUID()}.txt`);
  process.env.CC_TEST_ARGV_FILE = argvFile;
  // A fake claude that records its argv (one per line) and exits.
  const fake = fakeClaude('#!/bin/sh\nprintf "%s\\n" "$@" > "$CC_TEST_ARGV_FILE"\nexit 0\n');
  try {
    const s = new Session({ ...opts(), model: 'opus', permissionMode: 'plan', effort: 'high' });
    await once(s, 'exit');
    const argv = fs.readFileSync(argvFile, 'utf8');
    assert.match(argv, /--model\nopus/, 'model flag reaches claude');
    assert.match(argv, /--permission-mode\nplan/, 'permission-mode flag reaches claude');
    assert.match(argv, /--effort\nhigh/, 'effort flag reaches claude');
    assert.doesNotMatch(argv, /--bare/, 'never --bare (it would skip the approval hook)');
  } finally {
    fake.restore();
    delete process.env.CC_TEST_ARGV_FILE;
    fs.rmSync(argvFile, { force: true });
  }
});

test('send() on a LIVE session still flips it to working (the guard does not over-fire)', async () => {
  // A claude that stays alive reading stdin, so the session is non-terminal when we steer it.
  const fake = fakeClaude('#!/bin/sh\ncat > /dev/null\n');
  try {
    const s = new Session(opts());
    // The Session emits 'state' on its first transition; the child's 'spawn' moves 'starting' →
    // 'ready' (alive, no init yet). Wait for that so we steer a genuinely live session.
    while (s.state === 'starting') await once(s, 'state');
    assert.notEqual(s.state, 'working');

    s.send('do the thing');
    assert.equal(s.state, 'working', 'a live session accepts steering and reports working');

    s.close(); // ends stdin so the fake `cat` exits and nothing is left running
    await once(s, 'exit');
  } finally {
    fake.restore();
  }
});
