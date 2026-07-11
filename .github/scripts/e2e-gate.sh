#!/usr/bin/env bash
# e2e-gate.sh — hold the live-AI e2e job until EVERY other signal on the PR
# is green, then let the (paid) model calls run.
#
# Why this exists: `needs:` can only gate on jobs in the same workflow file,
# but the repo's merge bar spans other workflows (CodeQL's Analyze, audit)
# and GitHub Apps (Cursor Bugbot, GitGuardian, Vercel) — plus "every review
# thread resolved", which is not a check at all. This script polls the
# check-runs API, the commit-status API, and the reviewThreads GraphQL until
# all of them pass, mirroring the repo merge policy:
#
#   - every check run must complete with conclusion "success". NEUTRAL is
#     NOT a pass: Cursor Bugbot reports neutral ("skipping") exactly when it
#     has open review conversations, so a neutral Bugbot keeps this gate
#     closed until the threads are fixed/resolved (Bugbot then flips to
#     SUCCESS on its own, no new commit needed — re-run this job).
#   - every commit status context must be "success" (GitGuardian/Vercel
#     report here on some plans; harmless overlap if they use check runs).
#   - zero unresolved review threads.
#
# Hard failures (failure / cancelled / timed_out / action_required / error)
# exit immediately; pending or neutral states poll until GATE_TIMEOUT_MINS,
# then fail with a summary — "Re-run failed jobs" picks the gate back up
# after a human resolves whatever it was waiting on.
#
# Expected env: GH_TOKEN, REPO ("owner/name"), SHA, PR (number).
set -euo pipefail

# The gate must never wait on itself, and the dependabot labeler only runs
# (by design) on dependabot PRs — it reports "skipped" everywhere else.
EXCLUDED_CHECKS='["E2E (live AI + AiFlows)", "label-dependabot"]'

GATE_TIMEOUT_MINS="${GATE_TIMEOUT_MINS:-20}"
POLL_SECONDS="${POLL_SECONDS:-30}"

deadline=$(( $(date +%s) + GATE_TIMEOUT_MINS * 60 ))
attempt=0

while true; do
  attempt=$(( attempt + 1 ))
  blockers=""

  # --- Check runs (Actions jobs across ALL workflows + most GitHub Apps) ---
  # filter=latest (the default) returns only the newest attempt per check,
  # so a re-run never trips over its own failed history.
  check_runs=$(gh api "repos/${REPO}/commits/${SHA}/check-runs" --paginate -q '
    .check_runs[] | {name, status, conclusion}' | jq -s '.')
  not_green=$(jq -r --argjson excluded "$EXCLUDED_CHECKS" '
    map(select(.name as $n | $excluded | index($n) | not))
    | map(select(.status != "completed" or .conclusion != "success"))
    | .[] | "\(.name): \(.status)/\(.conclusion // "-")"' <<<"$check_runs")
  hard_failed=$(jq -r --argjson excluded "$EXCLUDED_CHECKS" '
    map(select(.name as $n | $excluded | index($n) | not))
    | map(select(.conclusion as $c
        | ["failure", "cancelled", "timed_out", "action_required"] | index($c)))
    | .[] | .name' <<<"$check_runs")
  if [ -n "$hard_failed" ]; then
    echo "::error::e2e gate: check(s) failed — $(tr '\n' ' ' <<<"$hard_failed")"
    exit 1
  fi
  [ -n "$not_green" ] && blockers+="checks not green:"$'\n'"$not_green"$'\n'

  # --- Commit statuses (legacy status API — some apps report here) ---
  statuses=$(gh api "repos/${REPO}/commits/${SHA}/status" -q '
    .statuses | map({context, state}) | unique_by(.context)')
  status_failed=$(jq -r '
    map(select(.state == "failure" or .state == "error")) | .[] | .context' <<<"$statuses")
  if [ -n "$status_failed" ]; then
    echo "::error::e2e gate: commit status(es) failed — $(tr '\n' ' ' <<<"$status_failed")"
    exit 1
  fi
  status_pending=$(jq -r '
    map(select(.state != "success")) | .[] | "\(.context): \(.state)"' <<<"$statuses")
  [ -n "$status_pending" ] && blockers+="statuses not green:"$'\n'"$status_pending"$'\n'

  # --- Review threads: every conversation resolved (merge-policy item 2) ---
  owner="${REPO%%/*}"
  name="${REPO##*/}"
  unresolved=$(gh api graphql \
    -F owner="$owner" -F name="$name" -F pr="$PR" \
    -f query='query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) { nodes { isResolved } }
        }
      }
    }' -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length')
  [ "$unresolved" -gt 0 ] && blockers+="unresolved review threads: ${unresolved}"$'\n'

  if [ -z "$blockers" ]; then
    echo "e2e gate: every other check is green and all threads are resolved — running live suite."
    exit 0
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::e2e gate: timed out after ${GATE_TIMEOUT_MINS}m waiting on:"
    echo "$blockers"
    echo "Fix/resolve the blockers, then re-run this job (no new commit needed unless code must change)."
    exit 1
  fi

  echo "e2e gate poll #${attempt} — still waiting on:"
  echo "$blockers"
  sleep "$POLL_SECONDS"
done
