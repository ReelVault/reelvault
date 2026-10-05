#!/usr/bin/env bash
# Scale profile runner: re-runs the load-bearing suites at an elevated row count
# and drops JSON+text results into benchmark-results/ for before/after reads.
#
#   SCALE_ROWS=10000 SCALE_SUITES="http write database" scripts/benchmarks/../run-scale.sh
#
# Defaults: 10k rows, the read/write/repo core. 100k is opt-in — seeding it
# in-process takes minutes (see COLD_START_ROWS for the same tradeoff).
set -euo pipefail
cd "$(dirname "$0")/../.."

ROWS="${SCALE_ROWS:-10000}"
SUITES="${SCALE_SUITES:-http write database repositories workers composite write-admin}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="benchmark-results"
mkdir -p "$OUT"

for suite in $SUITES; do
	echo "=== scale profile: $suite @ $ROWS rows ==="
	bun run benchmark "$suite" --rows "$ROWS" --json="$OUT/scale-$ROWS-$suite-$STAMP.json" 2>&1 | tee "$OUT/scale-$ROWS-$suite-$STAMP.txt"
done

echo "=== scale profile done: results in $OUT/scale-$ROWS-*- $STAMP ==="
