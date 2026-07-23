# Contributing

Thanks for your interest in claude-code-remote. This project gates whether tool calls execute on a
machine, so correctness and clarity matter more than speed here.

## Setup

- **Node 24 or newer** is required (there is an `.nvmrc`). The project uses strip-only TypeScript
  execution, `node:sqlite`, and X25519 in `node:crypto`, all of which need Node 24.
- `npm install` at the repo root. This is **not a build**: it only links the workspace packages so
  they can import each other by name. There is no compile step.
- To run the integration suite you also need **`uv` and Python 3.11+** (see `tests/pyproject.toml`).
  The daemon and CLI themselves have zero runtime dependencies.

## The gate

Before opening a pull request, this must pass:

```bash
npm run typecheck && npm test
```

- `npm run typecheck` runs `tsc --noEmit`. Node strips type annotations without checking them, so
  this is load-bearing, not decoration: without it, every annotation in the codebase is a comment.
- `npm test` runs the Node unit tests (per package, beside the code) and the two repo-level meta
  tests in `tests/meta`.

For more coverage:

```bash
./tests/run-unit.sh          # the gate above, plus the zero-cost integration scripts (needs uv)
./tests/run-integration.sh   # spawns real daemons and real headless claude sessions. Minutes, real API cost.
```

## Architecture rules the tests enforce

Two meta tests will fail your PR if you cross a boundary, so it helps to know them up front:

- **`tests/meta/architecture.test.ts`** enforces that daemon layers depend inward only: `domain` →
  `application` → `infrastructure` / `interface`, with `index.ts` as the only module that knows all
  of them. The `protocol` kernel must import nothing internal, and the `cli` and `daemon` packages
  must not import each other. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **`tests/meta/module-load.test.ts`** parses and imports every module. Strip-only mode rejects a few
  TypeScript constructs (parameter properties, enums) at load time that a syntax check accepts, so
  the test imports modules rather than only parsing them. It also asserts a floor on how many modules
  it discovers, so a whole directory cannot silently drop out of coverage.

## Testing conventions

- Unit tests live next to the code, in each package's `tests/` directory, and run under
  `node --test`.
- Integration tests live in `tests/integration/` and drive a real daemon. Many are zero API cost (a
  refused spawn, or a synthetic approval injected into the hook socket) and run in `run-unit.sh`; the
  ones that spawn a real `claude -p` session and cost API tokens run in `run-integration.sh`.
- Daemon-based integration tests run serially: each isolates its own store and database in a temp
  path, and kills any daemon from the previous test.
- A change ships with its tests. When a change is behavioral, add a test that would fail without the
  change.

## The security-critical files

Changes to these deserve extra scrutiny and the integration suite:

- `hook/approve-bridge.mjs`: the fail-closed approval boundary. Zero dependencies by design; keep it
  that way.
- Anything under `packages/daemon/src/interface/` (the trust boundary: pairing, frame authentication,
  dedup) and `packages/protocol/src/` (the wire format and crypto contract).

## Style

- Two-space indentation for JS/TS, four for Python (there is an `.editorconfig`).
- Match the surrounding code. Comments explain **why**, not what.
- No em dashes in prose or comments. Use commas, colons, parentheses, or separate sentences.

## Reporting security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
