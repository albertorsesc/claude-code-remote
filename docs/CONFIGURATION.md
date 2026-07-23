# Configuration

Everything is configured through environment variables. Defaults are chosen so that the local
Quickstart needs none of them. Values used as caps are validated at startup: an unparseable value
makes the daemon refuse to start rather than silently disabling the cap.

## Daemon

Read by `packages/daemon/src/index.ts` (via `infrastructure/config.ts`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CC_CLIENT_SOCK` | `/tmp/cc-client.sock` | The local Unix socket clients connect to. |
| `CC_DAEMON_SOCK` | `/tmp/cc-daemon.sock` | The local socket the approval bridge connects to. |
| `CC_STORE` | `~/.config/claude-code-remote/daemon.json` | Daemon identity and paired-device registry. |
| `CC_DB_PATH` | `~/.config/claude-code-remote/daemon.db` | Durable SQLite store: approvals, session history, jobs, push registrations. |
| `CC_CLIENT_TCP_PORT` | unset (no TCP listener) | Port for the tailnet TCP listener. Setting it enables off-machine access. |
| `CC_CLIENT_TCP_HOST` | `auto` | Bind address. `auto` discovers the Tailscale IP. A literal IP overrides it; `0.0.0.0` binds every interface and logs a warning. |
| `CC_HOOK_SELF_DENY_MS` | `1200000` (20 min) | How long the bridge waits before self-denying. Must stay comfortably below each managed project's settings `timeout`. |
| `CC_MAX_CONCURRENT_SESSIONS` | unbounded | Cap on concurrently running sessions. Unset means spawns run immediately; setting it enables real queueing. |
| `CC_MAX_PAIRED_DEVICES` | `50` | Cap on paired devices, checked before the one-time secret is consumed. |
| `CC_REPLAY_MAX_DEVICES` | unset | Cap on how many devices the daemon keeps forward-replay history for. |
| `CC_REPLAY_MAX_EVENTS_PER_DEVICE` | unset | Cap on buffered replay events per device. Beyond it, a reconnect forces a full resync. |
| `CC_PUSH_ENABLED` | `false` | Opt in to push notifications. When off, registrations are still recorded but nothing is sent, so no third-party call is made. Accepts `1`/`0`, `true`/`false`, `yes`/`no`, `on`/`off`. |
| `CC_PUSH_ENDPOINT` | `https://exp.host/--/api/v2/push/send` | The push relay to POST to. Override to point at a mock in tests. |

## Client (`cc`)

Read by `packages/cli/src/cc.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CC_CLIENT_SOCK` | `/tmp/cc-client.sock` | The local socket to connect to (when no TCP address is set). |
| `CC_CLIENT_TCP_ADDR` | unset | `host:port` of a daemon reachable over TCP (for example a Tailscale address). When set, the CLI connects here instead of the Unix socket. |
| `CC_DEVICE_STORE` | `~/.config/claude-code-remote/device.json` | This device's paired identity and persistent outbound sequence. |
| `CC_PAIR_CODE` | unset | When set with `cc pair`, redeems an out-of-band pairing code minted by `cc pair-code` on the daemon machine. |
| `CC_RECONNECT_MAX_ATTEMPTS` | `10` | Reconnect attempts before giving up. |
| `CC_RECONNECT_BASE_MS` | `1000` | Base delay for exponential backoff between reconnect attempts. |
| `CC_RECONNECT_MAX_DELAY_MS` | `15000` | Ceiling for the backoff delay. |
