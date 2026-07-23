// Architectural boundaries, enforced by execution rather than convention.
//
// Package-level rule the monorepo exists to guarantee:
//   protocol , pure shared kernel; imports NOTHING internal (node: builtins only)
//   daemon   , may import protocol; never the cli
//   cli      , may import protocol; never the daemon
// so the byte-exact wire contract has one source of truth and neither side depends on the other.
//
// Layer-level rule inside the daemon (Clean Architecture: dependencies point inward):
//   domain         , business rules. Imports nothing but node:/protocol/other domain.
//   application    , use cases. May import domain. NEVER infrastructure or interface.
//   infrastructure , adapters (sqlite, child_process, fs, tailscale). May import domain/application.
//   interface      , delivery (sockets, framing, handshake). May import domain/application.
//   index.ts       , the composition root, and the ONLY place allowed to know every layer.
//
// The point of asserting this in code: a layering convention that lives only in a README is a
// suggestion, and it decays on the first hurried import. This one fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Recursive: a flat readdir would stop at the layer directories and silently assert nothing. */
function filesIn(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesIn(rel, ext));
    else if (entry.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

/**
 * Every module specifier a file imports from (bare or relative), multiline-aware.
 *
 * Both quote styles. The repo happens to use single quotes everywhere today, so a double-quoted
 * import would have slipped past every boundary assertion in this file silently: the layering
 * would still be violated and the suite would still be green. Nothing enforces the quote style.
 */
function importsOf(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  return [...src.matchAll(/from\s*['\"]([^'\"]+)['\"]/g)].map((m) => m[1]);
}

/**
 * Does an import specifier reference a given workspace package? Catches the bare package root
 * (`@claudecode/cli`, the idiomatic and side-effectful form), a subpath (`@claudecode/cli/...`), and
 * a relative cross-package path (`.../cli/...`), but NOT a substring collision like `clientHub`
 * (which contains "cli"). Precision matters: a `cli/`-only check misses the bare root, and a bare
 * `cli` check false-flags every `client*` module.
 */
function referencesPackage(spec: string, pkg: string): boolean {
  return spec === `@claudecode/${pkg}` || spec.startsWith(`@claudecode/${pkg}/`) || spec.includes(`/${pkg}/`);
}

test('protocol is a pure kernel: imports only node: builtins and its own files', () => {
  const files = filesIn('packages/protocol/src');
  assert.ok(files.length > 0, 'no protocol files found, path resolution is broken');
  for (const f of files) {
    for (const spec of importsOf(f)) {
      const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
      assert.ok(ok, `${f} imports '${spec}', the protocol kernel must stay dependency-free`);
      // and it must never reach back up into a consumer. Precise (referencesPackage), not a substring
      // scan: the kernel's own `client.ts` reliability engine contains the substring "cli", so a naive
      // spec.includes('cli') would false-flag the shared machine the CLI and RN app both build on.
      assert.ok(
        !referencesPackage(spec, 'daemon') && !referencesPackage(spec, 'cli'),
        `${f} imports '${spec}', protocol must never depend on the daemon or a client`,
      );
    }
  }
});

test('the daemon never imports the cli', () => {
  for (const f of filesIn('packages/daemon/src')) {
    for (const spec of importsOf(f)) {
      assert.ok(!referencesPackage(spec, 'cli'), `${f} imports '${spec}', the daemon must not depend on a client`);
    }
  }
});

// Empty, and it stays empty. ResendBuffer and the ReliableClient state machine are client concerns
// shared by every client (the CLI today, the RN app next), so they live in the protocol kernel beside
// their mirror primitives (InboundStream), not in either client, and never in the daemon. The cli and
// daemon packages therefore share exactly one thing: the protocol kernel.
const CLI_TO_DAEMON_ALLOWLIST = new Set<string>([]);

test('the cli imports protocol, not the daemon (allowlist shrinks to empty as migration completes)', () => {
  const offenders: string[] = [];
  for (const f of filesIn('packages/cli/src')) {
    for (const spec of importsOf(f)) {
      // Catches a BARE `@claudecode/daemon` too: daemon's package.json `main` points at the
      // composition root, which opens sockets and starts listeners on import, so a stray bare-root
      // import would boot a daemon as a side effect AND still ship green under a `daemon/`-only check.
      if (referencesPackage(spec, 'daemon') && !CLI_TO_DAEMON_ALLOWLIST.has(spec)) {
        offenders.push(`${f} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'cli must depend only on @claudecode/protocol');
});

// --- daemon-internal layering -------------------------------------------------------------

/** Which layers each layer is forbidden to depend on (dependencies must point inward). */
const FORBIDDEN: Record<string, string[]> = {
  domain: ['application', 'infrastructure', 'interface'],
  application: ['infrastructure', 'interface'],
  infrastructure: ['interface'],
  // Delivery adapters should talk to the application layer, not reach for concrete adapters.
  interface: ['infrastructure'],
};

// EMPTY, and every layer is now genuinely clean.
//
// The last entry here was the client handshake importing the concrete Identity. That was not a
// naming problem: the handshake reached through it for `keys.privateKey` to derive a session key,
// so a type alias would have hidden real coupling. Identity now owns the derivation behind the
// PairingService port and keeps the keypair private, so the daemon's private key never crosses a
// module boundary at all. Any new entry here is a regression, not a TODO.
const LAYER_ALLOWLIST = new Set<string>([]);

test('daemon layers depend inward only (domain <- application <- infrastructure/interface)', () => {
  const offenders: string[] = [];
  for (const [layer, forbidden] of Object.entries(FORBIDDEN)) {
    for (const f of filesIn(`packages/daemon/src/${layer}`)) {
      for (const spec of importsOf(f)) {
        for (const bad of forbidden) {
          if (spec.includes(`/${bad}/`) || spec.startsWith(`./${bad}/`)) {
            const entry = `${f} -> ${spec}`;
            if (!LAYER_ALLOWLIST.has(entry)) offenders.push(entry);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'a daemon layer imported outward, dependencies must point inward');
});

test('every daemon source file lives in a known layer (or is the composition root)', () => {
  // The inward-dependency test only governs files under domain/application/infrastructure/interface.
  // A file added directly under packages/daemon/src (a stray `helpers.ts`) would be checked by NONE
  // of the layer rules and could import any layer in any direction while shipping green. Assert the
  // partition the layering test assumes, so an unplaced file fails the build instead of escaping it.
  const LAYERS = ['domain', 'application', 'infrastructure', 'interface'];
  const unplaced: string[] = [];
  for (const f of filesIn('packages/daemon/src')) {
    const rel = f.slice('packages/daemon/src/'.length);
    if (rel === 'index.ts') continue; // the sanctioned composition root
    if (!LAYERS.some((l) => rel.startsWith(`${l}/`))) unplaced.push(f);
  }
  assert.deepEqual(unplaced, [],
    'a daemon source file is not in index.ts or a layer directory, the layering test cannot govern it');
});

test('the domain layer is pure: no node: I/O, no adapters', () => {
  // Business rules that read the filesystem or open sockets cannot be tested without a machine
  // around them, which is how safety-critical rules end up exercised only end-to-end.
  const IO_MODULES = ['node:fs', 'node:net', 'node:child_process', 'node:sqlite', 'node:os', 'node:http'];
  const files = filesIn('packages/daemon/src/domain');
  assert.ok(files.length > 0, 'no domain files found, path resolution is broken');
  for (const f of files) {
    for (const spec of importsOf(f)) {
      assert.ok(
        !IO_MODULES.includes(spec),
        `${f} imports '${spec}', domain rules must stay pure and testable without I/O`,
      );
    }
  }
});
