#!/usr/bin/env bash
# Token-free sweep, no API cost: typecheck, the Node unit + meta tests, then the zero-cost
# integration scripts that spawn real daemons but never a real `claude -p`. Seconds, not minutes.
#
# The pure-Node gate (`npm run typecheck` + `npm test`) needs only Node 24. The integration scripts
# below additionally need `uv` and Python >= 3.11 (see tests/pyproject.toml). Run just the Node gate
# if you do not have uv installed.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Type check FIRST. Node strips types without checking them, so without this step every annotation
# in the codebase is decoration and the ports are unenforced. It is also the cheapest gate we have.
echo "=== typecheck ==="
./node_modules/.bin/tsc || { echo "FAIL: type errors"; exit 1; }
echo "PASS"
echo ""

# Unit tests live per package (packages/<pkg>/tests) plus the two repo-level meta tests (tests/meta).
node --test "packages/*/tests/*.test.ts" "tests/meta/*.test.ts" || exit 1

# Spawns real daemons (no `send`, so no API cost), fast enough to run every time.
cd tests || exit 1
echo ""; echo "=== hook_margin (spawn refused unless the target hook margin is safe) ==="
uv run python "integration/hook_margin.py" || exit 1
echo ""; echo "=== dual_transport (identical behavior over TCP and the Unix socket) ==="
uv run python "integration/dual_transport.py" || exit 1
echo ""; echo "=== job_queue (durable store + job queue) ==="
uv run python "integration/job_queue.py" || exit 1
echo ""; echo "=== client_restart_resilience (a watcher must survive a daemon restart) ==="
uv run python "integration/client_restart_resilience.py" || exit 1
echo ""; echo "=== pairing_transport (trust is bootstrapped locally, used anywhere) ==="
uv run python "integration/pairing_transport.py" || exit 1
echo ""; echo "=== orphan_recovery (nothing stays stuck 'running' after a crash) ==="
uv run python "integration/orphan_recovery.py" || exit 1
echo ""; echo "=== daemon_resilience (one bad message must not kill the control plane) ==="
uv run python "integration/daemon_resilience.py" || exit 1
echo ""; echo "=== resume_integrity (a resume claim must be possible) ==="
uv run python "integration/resume_integrity.py" || exit 1
echo ""; echo "=== reconnect_replay (cross-reconnect replay) ==="
uv run python "integration/reconnect_replay.py" || exit 1
echo ""; echo "=== revoke (device revocation) ==="
uv run python "integration/revoke.py" || exit 1
echo ""; echo "=== device_cap (paired-device cap) ==="
uv run python "integration/device_cap.py" || exit 1
echo ""; echo "=== command_redelivery (client→daemon reliable delivery) ==="
uv run python "integration/command_redelivery.py" || exit 1
echo ""; echo "=== hook_duplicate_claim (a duplicate tool_use_id cannot hijack an approval) ==="
uv run python "integration/hook_duplicate_claim.py" || exit 1
echo ""; echo "=== remote_pair_code (a second machine pairs out-of-band, no self-service hole) ==="
uv run python "integration/remote_pair_code.py" || exit 1
echo ""; echo "=== audit_render_injection (cc history neutralizes control chars in the audit trail) ==="
uv run python "integration/audit_render_injection.py" || exit 1
echo ""; echo "=== push_notify (a pending approval wakes a registered device, no detail leaks to the relay) ==="
uv run python "integration/push_notify.py" || exit 1
