// The base @claude-code-remote/protocol entry point must stay importable in React Native, which has no
// `node:` builtins. This walks index.ts's transitive re-exports and asserts none reaches a `node:`
// module, the whole point of the crypto seam. If someone re-exports crypto-node.ts (or otherwise
// pulls node:crypto into the base path), RN can no longer import the protocol even for its types,
// and this test fails the build instead of the failure surfacing only when the app is bundled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every source module transitively reachable from an entry, following relative import/export specifiers. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(path.join(SRC, file), 'utf8');
    for (const m of src.matchAll(/from\s*['"](\.\/[^'"]+)['"]/g)) stack.push(m[1].replace(/^\.\//, ''));
  }
  return seen;
}

test('the base protocol entry point imports no node: builtins (React-Native-portable)', () => {
  const offenders: string[] = [];
  for (const file of reachable('index.ts')) {
    const src = readFileSync(path.join(SRC, file), 'utf8');
    for (const m of src.matchAll(/from\s*['"](node:[^'"]+)['"]/g)) offenders.push(`${file} imports '${m[1]}'`);
  }
  assert.deepEqual(offenders, [],
    'a base-exported protocol module imports a node: builtin, React Native cannot import @claude-code-remote/protocol. ' +
    'Keep node-specific crypto behind the @claude-code-remote/protocol/node subpath (crypto-node.ts).');
});

test('the seam is real: the node crypto impl lives in the /node subpath, not the base', () => {
  assert.match(readFileSync(path.join(SRC, 'crypto-node.ts'), 'utf8'), /from 'node:crypto'/,
    'crypto-node.ts must contain the node:crypto implementation');
  assert.doesNotMatch(readFileSync(path.join(SRC, 'index.ts'), 'utf8'), /crypto-node/,
    'index.ts (the base entry) must NOT re-export crypto-node.ts');
});
