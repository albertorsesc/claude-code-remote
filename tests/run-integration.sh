#!/usr/bin/env bash
# Spawns real daemons and real headless `claude` sessions. Minutes, real API cost.
# Sequential: each script kills any daemon from the previous one.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/tests"
for s in auth_required skeleton_regression send_before_init init_and_failclosed ready_state audit_trail history interrupt session_config; do
  echo ""; echo "=== $s ==="
  uv run python "integration/$s.py" || exit 1
done
