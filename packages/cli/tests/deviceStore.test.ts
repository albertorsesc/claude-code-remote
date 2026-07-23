// Outbound sequence reservation, under real concurrency.
//
// The seq space belongs to the DEVICE, not to a process: the daemon dedups per device, so if two
// `cc` invocations draw the same number the daemon discards one as a duplicate resend and that
// user command never runs. Measured before the lock existed, with five concurrent invocations:
// only two landed, one exited 0 having done nothing, and two hung waiting for an ack that belonged
// to another process's command.
//
// Real child processes, not a simulation, the race is between processes, so anything sharing this
// one's memory would prove nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reserveOutSeq, saveDevice, loadDevice } from '../src/deviceStore.ts';

// Three up from packages/cli/tests/ to the repo root (child spawns + node cwd need the real root).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function freshStore(): string {
  const p = path.join(os.tmpdir(), `cc-devstore-${randomUUID()}.json`);
  saveDevice(p, {
    deviceId: 'dev-test', devicePrivateKey: 'x', devicePublicKey: 'y', daemonPublicKey: 'z',
  } as any);
  return p;
}

test('sequential reservations are strictly increasing from the persisted high-water', () => {
  const store = freshStore();
  assert.equal(reserveOutSeq(store), 1);
  assert.equal(reserveOutSeq(store), 2);
  assert.equal(reserveOutSeq(store), 3);
  assert.equal(loadDevice(store)!.outSeq, 3, 'the high-water is persisted for the next invocation');
});

test('CONCURRENT processes never draw the same sequence number', () => {
  const store = freshStore();
  const PROCS = 6;
  const PER_PROC = 5;

  // Each child reserves PER_PROC numbers against the shared store and prints them.
  const child = `
    import { reserveOutSeq } from '${path.join(ROOT, 'packages/cli/src/deviceStore.ts')}';
    const out = [];
    for (let i = 0; i < ${PER_PROC}; i++) out.push(reserveOutSeq(process.argv[2]));
    console.log(JSON.stringify(out));
  `;
  const childPath = path.join(os.tmpdir(), `cc-reserve-child-${randomUUID()}.ts`);
  fs.writeFileSync(childPath, child);

  // Launched together so they genuinely overlap in the read-modify-write window.
  const results = execFileSync('bash', ['-c',
    Array.from({ length: PROCS }, () => `node ${childPath} ${store} &`).join(' ') + ' wait',
  ], { encoding: 'utf8', cwd: ROOT });

  const drawn = results.trim().split('\n').flatMap((l) => JSON.parse(l) as number[]);
  const unique = new Set(drawn);

  assert.equal(drawn.length, PROCS * PER_PROC, 'every child reported its full set');
  assert.equal(unique.size, drawn.length,
    `two processes drew the same seq, the daemon would dedup one away and that command would ` +
    `silently never run. drawn=${drawn.sort((a, b) => a - b).join(',')}`);
  assert.deepEqual(
    [...unique].sort((a, b) => a - b),
    Array.from({ length: PROCS * PER_PROC }, (_, i) => i + 1),
    'the allocated numbers form a contiguous run with no gaps or repeats',
  );
  fs.unlinkSync(childPath);
});

test('a stale lock left by a crashed invocation does not wedge the next one forever', () => {
  const store = freshStore();
  fs.writeFileSync(`${store}.lock`, '');
  // Backdate it beyond the staleness threshold, as a dead process would leave it.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${store}.lock`, old, old);
  assert.equal(reserveOutSeq(store), 1, 'the stale lock is reclaimed rather than blocking forever');
});
