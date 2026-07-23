#!/usr/bin/env bash
# e2e-usage-summary.sh — aggregate the live e2e suite's billed-token log
# (test-results/e2e-gemini-usage.jsonl, written per call by
# tests/e2e/usage-log.ts) into the GitHub job summary, so every run's paid
# Gemini footprint is visible next to its verdict and reconcilable against
# AI Studio's per-key spend view + /admin/gemini (docs/GEMINI-SPEND.md).
#
# Never fails the job: usage reporting is observability, not a gate.
set -uo pipefail

LOG="test-results/e2e-gemini-usage.jsonl"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ ! -s "$LOG" ]; then
  echo "No Gemini usage log at $LOG — the suite made no recorded paid calls." | tee -a "$SUMMARY"
  exit 0
fi

TABLE=$(jq -rs '
  map(select(.model? and (.promptTokens? != null) and (.outputTokens? != null)))
  | group_by(.model)
  | map({
      model: .[0].model,
      calls: length,
      prompt: (map(.promptTokens) | add),
      output: (map(.outputTokens) | add)
    })
  | (sort_by(-.output)
     | map("| \(.model) | \(.calls) | \(.prompt) | \(.output) |")
     | join("\n"))
    + "\n| **total** | **\(map(.calls) | add)** | **\(map(.prompt) | add)** | **\(map(.output) | add)** |"
' "$LOG" 2>/dev/null) || {
  echo "Could not parse $LOG — skipping the usage summary." | tee -a "$SUMMARY"
  exit 0
}

{
  echo "### Gemini token usage (live e2e)"
  echo ""
  echo "| Model | Calls | Prompt tokens | Output tokens (incl. thinking) |"
  echo "|---|---|---|---|"
  echo "$TABLE"
} | tee -a "$SUMMARY"
exit 0
