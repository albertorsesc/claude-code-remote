// every committed module parses under Node's strip-only TypeScript mode.
// Parse-only (--check), not import: entry points have side effects (servers, sockets)
// and would hang an import-based check.
//
// --check alone is NOT sufficient, proven the hard way while building the job queue.
// A TypeScript parameter property (constructor(private opts: ...)) passed `node --check`
// cleanly but threw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX the moment the module was actually
// imported. --check validates syntax; strip-only mode's own restrictions (parameter
// properties, enums, etc.) are only enforced when the TypeScript-stripping transform
// actually runs, which only happens at real load time. So every module that's safe to
// import without side effects (i.e. not index.ts/cc.ts, which open real sockets) gets
// dynamically imported too, not just parse-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Recursive on purpose. This used to be a flat readdirSync, which meant that the moment the daemon
// grew layer subdirectories (domain/, application/, ...) it would have found only the files left at
// the top level and silently stopped checking the other eight modules, still reporting green while
// testing almost nothing. A test that quietly narrows its own scope is worse than a missing test.
function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel);
  }
  return out;
}

// Unit tests live per package (packages/<pkg>/tests), plus the two repo-level meta tests here.
const testDirs = [
  'packages/protocol/tests',
  'packages/daemon/tests',
  'packages/cli/tests',
  'tests/meta',
];

const files = [
  ...sourceFiles('packages/protocol/src', ['.ts']),
  ...sourceFiles('packages/daemon/src', ['.ts']),
  ...sourceFiles('packages/cli/src', ['.ts']),
  ...sourceFiles('hook', ['.mjs']),
  ...testDirs.flatMap((d) => sourceFiles(d, ['.ts'])),
];

// A coverage FLOOR, not a nicety. `files.length > 0` would still pass if discovery silently
// collapsed to a single file, exactly the failure the recursive walk above exists to prevent.
// These are the real current counts, asserted as minimums: adding modules never breaks this,
// but losing a directory (or a whole package's tests) does, loudly, naming what went missing.
const MIN_DISCOVERED: Record<string, number> = {
  'packages/protocol/src': 10,
  'packages/daemon/src': 23,
  'packages/cli/src': 4,
  'packages/protocol/tests': 7,
  'packages/daemon/tests': 17,
  'packages/cli/tests': 3,
  'tests/meta': 2,
};

test('module discovery still reaches every package (guards against silently testing nothing)', () => {
  for (const [dir, min] of Object.entries(MIN_DISCOVERED)) {
    const found = sourceFiles(dir, ['.ts']);
    assert.ok(
      found.length >= min,
      `${dir}: discovered ${found.length} module(s), expected at least ${min}. ` +
      `Either modules were deleted, or file discovery stopped descending into subdirectories ` +
      `and the suite is now testing far less than it reports.`,
    );
  }
});

test('every source module parses under Node strip-only TypeScript mode', () => {
  assert.ok(files.length > 0, 'no source files found, path resolution is broken');
  for (const f of files) {
    assert.doesNotThrow(
      () => execFileSync('node', ['--check', f], { cwd: ROOT, stdio: 'pipe' }),
      `${f} failed to parse`,
    );
  }
});

// Entry points have top-level side effects (open sockets, connect) and would hang an
// import-based check; everything else in packages/daemon/src and packages/cli/src is import-safe by design
// (classes/functions only, no top-level execution).
const ENTRY_POINTS = new Set(['packages/daemon/src/index.ts', 'packages/cli/src/cc.ts']);
const importableFiles = [
  ...sourceFiles('packages/protocol/src', ['.ts']),
  ...sourceFiles('packages/daemon/src', ['.ts']),
  ...sourceFiles('packages/cli/src', ['.ts']),
].filter((f) => !ENTRY_POINTS.has(f));

test('every non-entry-point module actually loads under strip-only mode, not just parses', async () => {
  assert.ok(importableFiles.length > 0, 'no importable source files found, path resolution is broken');
  for (const f of importableFiles) {
    await assert.doesNotReject(
      () => import(pathToFileURL(path.join(ROOT, f)).href),
      `${f} failed to load (parsed fine, but strip-only mode rejected something at import time)`,
    );
  }
});
