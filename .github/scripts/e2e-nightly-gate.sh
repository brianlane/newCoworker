#!/usr/bin/env bash
# e2e-nightly-gate.sh: decide whether the scheduled E2E Nightly paid suite
# should run. Emits run=true|false to $GITHUB_OUTPUT.
#
# Rules (schedule only; workflow_dispatch always runs):
#   1. No previous completed run of this workflow → run (first night).
#   2. Previous run's "E2E full suite (nightly)" job failed → run (retry;
#      do not strand a red nightly until the next merge).
#   3. At least one PR merged into main after the previous run started → run.
#   4. Otherwise → skip (no paid Gemini calls).
#   5. Any gh/jq/API error → run (fail open; same posture as e2e-scope.sh).
#
# Expected env: GH_TOKEN, GITHUB_REPOSITORY (or REPO), GITHUB_RUN_ID,
# GITHUB_EVENT_NAME, GITHUB_OUTPUT.
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:?GITHUB_REPOSITORY or REPO is required}}"
RUN_ID="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
EVENT_NAME="${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
SUITE_JOB_NAME="E2E full suite (nightly)"
WORKFLOW_FILE="e2e-nightly.yml"

emit_run() {
  local value="$1"
  local reason="$2"
  echo "e2e-nightly-gate: run=${value}: ${reason}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "run=${value}" >>"$GITHUB_OUTPUT"
  fi
}

fail_open() {
  emit_run true "fail-open: $1"
  exit 0
}

if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
  emit_run true "workflow_dispatch always runs the full suite"
  exit 0
fi

runs_json=$(gh api \
  "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=completed&per_page=10" \
  2>/dev/null) || fail_open "could not list previous workflow runs"

prev_json=$(jq -c --argjson current "$RUN_ID" '
  [.workflow_runs[] | select(.id != $current)]
  | sort_by(.run_started_at // .created_at)
  | reverse
  | .[0] // empty
' <<<"$runs_json" 2>/dev/null) || fail_open "could not parse previous workflow runs"

if [ -z "$prev_json" ] || [ "$prev_json" = "null" ]; then
  emit_run true "no previous completed nightly run on main"
  exit 0
fi

prev_id=$(jq -r '.id' <<<"$prev_json")
prev_since=$(jq -r '.run_started_at // .created_at' <<<"$prev_json")
prev_url=$(jq -r '.html_url // empty' <<<"$prev_json")

if [ -z "$prev_id" ] || [ "$prev_id" = "null" ] || [ -z "$prev_since" ] || [ "$prev_since" = "null" ]; then
  fail_open "previous run missing id or timestamp"
fi

echo "e2e-nightly-gate: previous run ${prev_id} started at ${prev_since}${prev_url:+ ($prev_url)}"

jobs_json=$(gh api \
  "repos/${REPO}/actions/runs/${prev_id}/jobs?filter=latest" \
  --paginate 2>/dev/null) || fail_open "could not list jobs for previous run ${prev_id}"

suite_conclusion=$(jq -rs --arg name "$SUITE_JOB_NAME" '
  [.[].jobs[]? | select(.name == $name) | .conclusion]
  | last // empty
' <<<"$jobs_json" 2>/dev/null) || fail_open "could not parse jobs for previous run ${prev_id}"

if [ "$suite_conclusion" = "failure" ]; then
  emit_run true "previous suite job failed (retry even with no merges)"
  exit 0
fi

# Recent closed PRs against main; filter merged_at client-side for second precision.
# Paginate a modest window: with fewer merges this is plenty, and fail-open
# covers the pathological "more than N merges since last night" case via the
# empty-parse path only if jq itself blows up.
prs_json=$(gh api \
  "repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50" \
  2>/dev/null) || fail_open "could not list closed PRs against main"

merged_count=$(jq -r --arg since "$prev_since" '
  [
    .[]
    | select(.merged_at != null)
    | select(.merged_at > $since)
  ]
  | length
' <<<"$prs_json" 2>/dev/null) || fail_open "could not compare PR merged_at timestamps"

if [ "${merged_count:-0}" -gt 0 ]; then
  sample=$(jq -r --arg since "$prev_since" '
    [
      .[]
      | select(.merged_at != null)
      | select(.merged_at > $since)
      | "#\(.number) merged \(.merged_at)"
    ]
    | .[0:5]
    | join(", ")
  ' <<<"$prs_json" 2>/dev/null || true)
  emit_run true "${merged_count} PR(s) merged into main since ${prev_since}${sample:+: ${sample}}"
  exit 0
fi

emit_run false "no PRs merged into main since previous nightly (${prev_since}); skipping paid suite"
exit 0
