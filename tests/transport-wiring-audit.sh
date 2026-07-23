#!/usr/bin/env bash
# Is the transport layer (crypto/pairing/sync) actually wired into production code, or built and
# verified in isolation? Evidence, not assumption. Informational: it is expected to show
# "NOT IMPORTED" until the wiring lands, and is not a pass/fail gate.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "--- imports in daemon entry point (index.ts) ---"
grep -nE "^import" packages/daemon/src/index.ts | sed 's/^/  /'
echo ""
echo "--- who imports each transport module? ---"
for m in crypto pairing sync; do
  hits=$(grep -rln "from '.*${m}.ts'" packages/daemon/src cli 2>/dev/null | grep -v "^packages/daemon/src/${m}.ts")
  if [ -z "$hits" ]; then
    echo "  ${m}.ts: NOT IMPORTED by any production module"
  else
    echo "  ${m}.ts imported by:"; echo "$hits" | sed 's/^/      /'
  fi
done
echo ""
echo "--- transport surface actually in use ---"
grep -nE "createServer|listen\(" packages/daemon/src/index.ts | sed 's/^/  /'
