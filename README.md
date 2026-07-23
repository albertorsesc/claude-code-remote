# claude-code-remote

Own the headless Claude Code sessions running on your machine, and watch, steer, and approve their
tool calls from another device, including your phone, over an end-to-end-encrypted connection.

> Not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are
> trademarks of Anthropic. This is an independent, community-built tool that interoperates with
> Claude Code. See [NOTICE](NOTICE).

## What this is

claude-code-remote is a daemon that starts and owns headless Claude Code sessions on your own machine and
lets you watch, steer, and approve their tool calls from somewhere else. Each session runs as
`claude -p` with bidirectional `stream-json`, so it keeps your full local setup: MCP servers,
subagents, skills, and hooks. Your terminal stays free, and nothing runs in a PTY or a tmux pane.

Claude Code already ships `claude remote-control`, but it only manages sessions you explicitly link
to it. A session you started the normal way owns a PTY held by your terminal, and nothing external
can attach to it afterward. This project does not break that constraint. It removes the problem by
being the default way you start sessions, so "the session I forgot to link" is never a category. The
approval path is the point: a blocked `PreToolUse` hook holds each tool call open until a client
answers, and that block runs on your machine, so a tool never executes while your phone is offline or
out of range.

It is for people who run long Claude Code sessions on a Mac or workstation and want to stay in
control without sitting at that machine. You leave sessions running at your desk, and from a laptop
or a phone you see what each one is doing, answer the approval prompts it raises, redirect it, or
start new ones. The client connection is paired once and encrypted end to end (X25519 key agreement,
AES-256-GCM on every frame). It works over a local Unix socket with no network setup, or over a
[Tailscale](https://tailscale.com) tailnet when you want to reach it from off the machine.

**Status:** the daemon, the approval bridge, and a reference CLI client (`cc`) work end to end.
Approval decisions and session history are durable (SQLite), and spawns run through a job queue. The
mobile app is scaffolded: its on-device crypto is built and proven byte-for-byte compatible with the
daemon, but its screens are not built yet. The CLI speaks the exact protocol the phone will, so what
runs today is the whole system minus the phone UI.

## How it works

```
   phone / laptop client          paired + encrypted           (clients, same protocol)
          |                        (X25519 + AES-256-GCM)
   /tmp/cc-client.sock   or   100.x.x.x:PORT (Tailscale)
          |
      +---------+   spawns & owns
      | daemon  | ------------------> claude -p --input-format stream-json ...
      +---------+                              |
          ^                                    | PreToolUse
   /tmp/cc-daemon.sock  (local, unauth'd)      v
          +------------------------- hook/approve-bridge.mjs  (blocks until decided)
```

1. The daemon spawns each session as a headless `claude -p` process and tracks its state from typed
   hook notifications, not by scraping output.
2. When a session wants to run a tool, Claude Code fires a `PreToolUse` hook. The bridge
   (`hook/approve-bridge.mjs`) holds that call open and asks the daemon for a decision. Because the
   block lives on your machine, the tool cannot run while no one has answered.
3. A paired client (the CLI today, the phone next) sees the pending approval and answers it. Exactly
   one blocked hook consumes exactly one answer, so a first-decision-wins compare-and-swap is enough.
4. Everything after pairing is sealed: the client authenticates once, derives a session key, and
   every frame is encrypted. Reconnects resume from where the client left off.

For the trust model, the crypto, and the reliability design, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Requirements

- **Node 24 or newer.** The project runs its TypeScript directly with no build step, and uses
  `node:sqlite` and X25519 in `node:crypto`, all of which need Node 24. There is an `.nvmrc`.
- **`claude` on your PATH**, needed only to actually spawn sessions (pairing and reads work without
  it). Tested against claude 2.1.217.
- **`uv` and Python 3.11+** only if you want to run the integration test suite (see
  [CONTRIBUTING.md](CONTRIBUTING.md)). The daemon and CLI themselves have zero runtime dependencies.

## Quickstart (local)

Runs entirely on one machine over a Unix socket. No Tailscale, no network config.

### 1. Clone and link the workspace

```bash
git clone https://github.com/albertorsesc/claude-code-remote.git
cd claude-code-remote
npm install
```

`npm install` is not a build. It only creates the `node_modules` symlinks that let the packages
import each other by name (`@claude-code-remote/protocol`). Skip it and both the daemon and the tests fail
with `ERR_MODULE_NOT_FOUND`.

For the rest of this guide, alias the CLI so the commands read cleanly:

```bash
alias cc="node $(pwd)/packages/cli/src/cc.ts"
```

Without the alias, run `node packages/cli/src/cc.ts <command>` wherever you see `cc <command>`.

### 2. Install the approval bridge into a project you want to manage

The bridge is a per-project hook. A session can only be gated in a project whose
`.claude/settings.json` runs it. Replace `/ABS/PATH/TO/claude-code-remote` with this repo's absolute
path.

```bash
mkdir -p /path/to/your/project/.claude
cat > /path/to/your/project/.claude/settings.json <<'JSON'
{ "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [
  { "type": "command",
    "command": "/usr/bin/env node /ABS/PATH/TO/claude-code-remote/hook/approve-bridge.mjs",
    "timeout": 1800 } ] } ] } }
JSON
```

The `1800` (seconds) timeout is deliberate. The bridge self-denies well before it, tunable with
`CC_HOOK_SELF_DENY_MS` (default 1200000 ms). The daemon refuses to spawn into a project whose
settings timeout is not comfortably larger than that self-deny window, so keep the settings timeout
above the self-deny value.

### 3. Start the daemon

```bash
node packages/daemon/src/index.ts
```

It listens on a local Unix socket (`/tmp/cc-client.sock`) and writes its state to
`~/.config/claude-code-remote/` (`daemon.db`, `daemon.json`). Leave it running.

### 4. Pair this machine (one time)

In a second terminal:

```bash
cc pair
```

Pairing bootstraps over the local socket and persists to `~/.config/claude-code-remote/device.json`.

### 5. Drive it

Watch the fleet and answer approvals live:

```bash
cc watch
```

In another terminal, start a session in the project you set up in step 2, then send it work:

```bash
cc spawn /path/to/your/project first-session
cc send <sessionId> "list the files here and summarize the build"
```

When the session needs a tool approved, `cc watch` shows it pending with a `toolUseId`. Answer it:

```bash
cc allow <toolUseId>
cc deny  <toolUseId> "use the existing helper instead"
```

The tool call stays blocked on your machine until you answer, so nothing runs unattended.

If `spawn` is refused with a hook-margin error, the target project's settings timeout is too tight
relative to `CC_HOOK_SELF_DENY_MS`. Raise the timeout in step 2 (or lower the self-deny value) and
retry.

## Everyday commands

| Command | What it does |
| --- | --- |
| `cc watch` | Stream the session fleet and live approval prompts. |
| `cc spawn <cwd> [label] [--model opus] [--mode plan] [--effort high]` | Start a managed session. |
| `cc send <sessionId> "<text>"` | Steer a session. Slash commands ride this too, e.g. `/model opus`. |
| `cc interrupt <sessionId>` | Interrupt a running session. |
| `cc model <sessionId> <model>` | Change the running session's model. |
| `cc mode <sessionId> plan` | Change permission mode (approval-preserving modes only). |
| `cc effort <sessionId> high` | Change reasoning effort (`low`/`medium`/`high`/`xhigh`/`max`). |
| `cc allow <toolUseId>` / `cc deny <toolUseId> "reason"` | Decide a pending tool call. |
| `cc history [limit]` | Print the durable approval decision history. |
| `cc revoke <deviceId>` | Revoke a paired device (disconnects it if connected). |

Slash commands, subagents, skills, MCP servers, plugins, and hooks are all inherited by every
headless session and driven through `send` as ordinary text. Per-session model, permission mode, and
effort are settable at spawn and mid-session. One deliberate restriction: the daemon refuses
permission modes that auto-approve tools (`bypassPermissions`, `acceptEdits`, `auto`, `dontAsk`,
`manual`), since a session that runs tools without a remote decision defeats the whole point. `plan`
is allowed, and omitting the mode uses the default per-tool approval flow.

## Reach it from your phone or another machine

Over a Tailscale tailnet, with `tailscale` on PATH on the daemon's machine:

```bash
# on the daemon's machine: CC_CLIENT_TCP_PORT alone auto-discovers the tailnet IP
CC_CLIENT_TCP_PORT=7443 node packages/daemon/src/index.ts
```

Pairing always bootstraps locally (a security boundary, explained in
[docs/PAIRING.md](docs/PAIRING.md)); the one-time secret leaves the daemon machine out of band (a QR
for a phone, a copy-pasteable code for a second machine) and never over the network. The full pairing
and remote-access flow, including `cc pair-code` for a second machine, is in
[docs/PAIRING.md](docs/PAIRING.md).

## Security model

Claude Code fails open on a degraded hook path, but an explicit `deny` is authoritative in every
permission mode. So the entire guarantee reduces to "does the bridge always answer", and
`hook/approve-bridge.mjs` is built to always answer, defaulting to deny. The client connection is
paired once and end-to-end encrypted, with no plaintext fallback. Read the full trust model, the
threat boundaries, and the deliberate tradeoffs (including what a Tailscale coordination server can
see) in [docs/SECURITY.md](docs/SECURITY.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Push notifications (opt-in)

A backgrounded phone still needs to hear that a tool call is waiting. A paired device registers its
push token with a sealed `register_push` command; when an approval goes pending the daemon wakes
every registered device. Off by default (`CC_PUSH_ENABLED=1` to enable). The wake ping carries no
session, tool, or command detail, only a generic marker, so nothing sensitive transits the push
service; the phone fetches the real pending approval over the encrypted channel. See
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the settings.

## Project layout

The daemon is layered so dependencies point inward: `domain` knows nothing, `application` knows
domain, `infrastructure` and `interface` know both, and `index.ts` is the only module that knows all
of them. That rule is enforced by a test (`tests/meta/architecture.test.ts`), which fails the suite
when a layer imports outward.

| Path | What |
| --- | --- |
| `hook/approve-bridge.mjs` | The security boundary. Zero dependencies, fail-closed by construction. |
| `packages/protocol/` | Shared wire kernel: sealed-frame format, reliability state machine, types. Importable in React Native. |
| `packages/daemon/` | The daemon, in clean-architecture layers (`domain` / `application` / `infrastructure` / `interface`) plus a composition root. |
| `packages/cli/` | The `cc` reference client. |
| `apps/mobile/` | The Expo React Native app (crypto core built and verified; screens pending). |
| `tests/` | Integration suite (real daemon + real session) and the test runners. |

A full file-by-file breakdown is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Testing

```bash
npm run typecheck && npm test   # the pure-Node gate: typecheck + unit + meta tests. Needs only Node 24.
./tests/run-unit.sh             # the above, plus the zero-cost integration scripts. Needs uv + Python 3.11+.
./tests/run-integration.sh      # spawns real daemons and real headless claude sessions. Minutes, real API cost.
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the suites are organized and how to add to them.

## Roadmap

- The React Native app: wire the shared `ReliableClient` and the verified crypto core into a
  Tailscale transport, then build the pairing, fleet, steer, and approval screens.
- Overnight soak: multi-day session holds are unproven; only minutes have been measured.

## License

[Apache-2.0](LICENSE).
