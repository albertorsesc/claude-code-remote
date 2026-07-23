# Architecture

## Packages

claude-code-remote is an npm workspace with three published-shape packages plus the mobile app:

- **`packages/protocol`** is the shared wire kernel. It holds the sealed-frame format, the shared
  types, the per-device sequence and dedup primitives, and the client reliability state machine. Its
  base entry point imports no `node:` builtins, so React Native can import it unchanged; the
  `node:crypto` implementation lives behind a separate `@claude-code-remote/protocol/node` subpath.
- **`packages/daemon`** is the daemon, in clean-architecture layers (below).
- **`packages/cli`** is the `cc` reference client.
- **`apps/mobile`** is the Expo React Native app. Its on-device crypto is built and verified
  byte-compatible with the daemon; the screens are not built yet. It is intentionally not part of the
  root npm workspace, so installing and running the daemon and CLI never pulls the React Native
  dependency tree.

## The daemon is layered, and the layering is enforced

Dependencies point inward:

- **`domain`** holds business rules. Pure, with no I/O, no adapters, no framework. It knows only
  `node:` primitives, the protocol kernel, and other domain modules.
- **`application`** holds use cases. It may import domain and the ports it declares itself, never a
  concrete adapter.
- **`infrastructure`** holds adapters. It is the only place that touches SQLite, child processes, the
  filesystem, or the network.
- **`interface`** holds delivery: sockets, framing, the handshake.
- **`index.ts`** is the composition root, the only module allowed to know all four layers. It builds
  the object graph and starts the listeners, and nothing else.

This is not a convention that lives in a README. `tests/meta/architecture.test.ts` asserts it and
fails the build when a layer imports outward, when a source file lands outside a known layer, or when
the domain layer reaches for I/O. Dependency inversion is expressed through ports: the application
declares the interfaces it needs (`JobStore`, `SessionHandle`, `PushSender`, and so on) and
infrastructure conforms to them structurally, so a use case can be tested without dragging in a child
process or a database.

## File-by-file

| Path | What |
| --- | --- |
| `hook/approve-bridge.mjs` | The security boundary. Zero dependencies, fail-closed by construction. |
| **`packages/protocol/src/`** | **Shared kernel.** The byte-exact wire contract, imported by both sides so neither owns it. |
| `frame.ts` | The portable E2E wire-format contract: sealed-frame shape, direction binding, associated data, field-visibility policy. No `node:` anything. |
| `crypto-node.ts` | The `node:crypto` seal/open implementation of that contract, behind the `@claude-code-remote/protocol/node` subpath. The RN app supplies a byte-compatible pure-JS one. |
| `sync.ts` | Per-device monotonic seq counter (`OutboundStream`) and inbound dedup (`InboundStream`). |
| `resend.ts` | The client's reverse buffer for command redelivery (unacked commands, bounded, hard-fail on overflow). |
| `client.ts` | `ReliableClient`: the sans-IO client reliability state machine (reconnect-replay, inbound dedup, command resend, ack accounting). Written and tested once, driven by the CLI and the RN app over their own transport and crypto. |
| `pairing-proof.ts` | The pairing HMAC, shared so the daemon and any client compute it identically. |
| **`packages/daemon/src/domain/`** | **Business rules. Pure.** |
| `approvals.ts` | Single arbiter, compare-and-swap, first decision wins. |
| `hookMargin.ts` | The hook-margin safety rule: is this project's hook timeout safely larger than self-deny? |
| `replay.ts` | Cross-reconnect replay buffer (plaintext, seq-addressed) with bounded eviction. |
| `deviceSessions.ts` | Per-device seq state, both directions: outbound replay and inbound dedup. |
| `permissionMode.ts` | Which permission modes preserve remote approval, and the refusal for the ones that do not. |
| **`packages/daemon/src/application/`** | **Use cases.** |
| `ports.ts` | The interfaces the application needs, so it never names a concrete adapter. |
| `commands.ts` | Client command dispatch, unit-testable without a live socket, with an exhaustiveness guard. |
| `jobs.ts` | Job queue for spawn requests: immediate under the concurrency cap, real queueing once it is set and hit. |
| `pushService.ts` | The push use case: stores per-device registrations and, on a new approval, fans a generic ping to the registered tokens. |
| **`packages/daemon/src/infrastructure/`** | **Adapters.** |
| `session.ts` | One headless session; state from typed hook notifications, not output scraping. |
| `db.ts` | Durable store (SQLite via `node:sqlite`): approvals, session history, job state, push registrations. |
| `pairing.ts` | Device identity and trust: `begin_pair` / `complete_pair` / `hello` / `revoke`. |
| `config.ts` | Environment parsing, validated: an unparseable cap refuses to start rather than silently disabling itself. |
| `hookMarginFile.ts` | Reads `.claude/settings.json` and applies the domain margin rule to it. |
| `tailscale.ts` | Resolves the tailnet IP to bind. Fails closed: no IP means no TCP listener, never `0.0.0.0`. |
| `expoPush.ts` | The Expo push adapter (`node:http`/`https`, no dependency): generic wake ping, fail-soft, endpoint injectable for tests. |
| **`packages/daemon/src/interface/`** | **Delivery.** |
| `clientHub.ts` | Owns live authenticated sockets and every sealed write and broadcast. |
| `clientConnection.ts` | The trust boundary: pairing handshake, frame authentication, inbound dedup, acks. |
| `hookBridge.ts` | One connection per blocked tool call, held open until decided. |
| `index.ts` | Composition root. |
| `packages/cli/src/cc.ts` | The `cc` client, and the reference host for `ReliableClient`: owns the socket, framing, reconnect backoff, the crypto adapter, the cross-process seq lock, and the render and exit policy. |
| `packages/cli/src/pairing.ts` | Encode/decode of the out-of-band pairing code. Pure, unit-testable apart from cc.ts's sockets. |

## Reliability: reconnect resumes, it does not just resync

A phone loses its socket constantly, so reconnect must not lose an approval, and a dropped
acknowledgement must never read as consent.

- **Forward direction (daemon to client).** `hello` optionally carries the last seq the client saw.
  If the daemon has enough replay history for that device, it re-seals exactly the missed events at
  their original seq, rather than sending a fresh full snapshot. Two cases always force a full resync
  instead of a partial or false-positive replay: the daemon process restarted since the client last
  connected (in-memory replay history does not survive that, even though on-disk identity does), and
  the client fell further behind than the bounded per-device buffer covers.
- **Reverse direction (client to daemon).** A `spawn` / `send` / `decide` that drops before the
  daemon confirms it is resent on reconnect, and the daemon dedups by per-device seq, so a resend is
  never re-executed (a resent `spawn` cannot create a second session). The daemon sends a cumulative
  ack, sealed so a relay cannot see a device's command count, and the client drops acked commands
  from its resend buffer. Across a daemon restart a resend does re-execute, which is safe because the
  restart already wiped the sessions and jobs a stale command would have touched.

Every command reconnects (not just `watch`) with bounded exponential backoff. This entire state
machine lives once in `packages/protocol/src/client.ts` (`ReliableClient`) so the CLI and the mobile
app share one tested implementation rather than each reimplementing it.

## No build step

The project runs its TypeScript directly under Node 24's strip-only mode. `npm install` only links
the workspace packages; there is no compile step. Because strip-only mode removes type annotations
without checking them, `tsc --noEmit` (via `npm run typecheck`) is the load-bearing type gate, not an
optimization. Strip-only mode also rejects a few TypeScript constructs at load time that `node --check`
accepts (parameter properties, enums), so a meta test imports every non-entry-point module to catch
that class of error, not just parse it.
