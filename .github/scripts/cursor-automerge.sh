#!/usr/bin/env bash
# Squash-merge a Cloud Agent PR only when the repo merge policy is satisfied.
#
# Cloud Agent PRs are opened as the human who started the run (not cursor[bot]),
# on a branch named `cursor/...`. Dependabot's automerge keys on the bot author
# and a label; that cannot see these PRs. This script is the same strict gate
# plus two extras Dependabot does not need:
#   - Cursor Bugbot must exist on the head SHA and conclude SUCCESS. The
#     GitHub ruleset deliberately does not require Bugbot (Dependabot PRs
#     never get it), so a merge API call would otherwise succeed with Bugbot
#     still NEUTRAL or missing.
#   - mergeStateStatus must be CLEAN on two consecutive reads. Required
#     checks are created in waves; a one-shot "every existing check is
#     success" reading is the false-green trap from PR #1181.
#
# Drafts are skipped: that is the hold. Convert back to draft to stop a merge.
# Fork PRs are skipped: workflow_run / check_run run with a write token.
# Expected env: GH_TOKEN, REPO, EVENT_NAME, HEAD_SHA, HEAD_BRANCH.
# POLL_SECONDS defaults to 30 (the documented two-poll gap); tests set 0.
# MERGE_RETRY_SLEEP defaults to attempt*5; tests set 0.
set -euo pipefail

POLL_SECONDS="${POLL_SECONDS:-30}"
EXCLUDE_CHECKS="${EXCLUDE_CHECKS:-[\"label-dependabot\",\"auto-merge\",\"cursor-auto-merge\"]}"
BUGBOT_CHECK="${BUGBOT_CHECK:-Cursor Bugbot}"

merge_with_retry() {
  local pr="$1"
  local attempt=1
  local max=5
  local out state

  while [ "$attempt" -le "$max" ]; do
    if out=$(gh pr merge "$pr" --repo "$REPO" --squash --delete-branch 2>&1); then
      echo "Merged PR #$pr (attempt $attempt/$max)."
      return 0
    fi

    echo "Merge attempt $attempt/$max for PR #$pr failed: $out"

    case "$out" in
      *"Base branch was modified"*|*"try the merge again"*|*"not mergeable"*)
        : # retryable race
        ;;
      *)
        echo "Non-retryable merge error; leaving PR #$pr for a human."
        return 1
        ;;
    esac

    state=$(gh pr view "$pr" --repo "$REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
    case "$state" in
      MERGED|CLOSED)
        echo "PR #$pr is now $state; nothing left to retry."
        return 0
        ;;
      OPEN)
        :
        ;;
      *)
        echo "Could not read PR #$pr state (got '${state:-<empty>}'); assuming still open and retrying."
        ;;
    esac

    sleep "${MERGE_RETRY_SLEEP:-$(( attempt * 5 ))}"
    attempt=$(( attempt + 1 ))
  done

  echo "Exhausted $max merge attempts for PR #$pr; the next sweep will retry."
  return 1
}

# Print why this PR is not mergeable, or nothing if the gate is clear.
# Reads live API state; the caller re-invokes after POLL_SECONDS.
gate_reasons() {
  local pr="$1"
  local pr_json cur_sha state is_draft head_ref merge_state
  local checks filtered incomplete not_success bugbot
  local status_json status_total status_state unresolved

  pr_json=$(gh pr view "$pr" --repo "$REPO" \
    --json headRefOid,headRefName,state,isDraft,mergeStateStatus,isCrossRepository)
  cur_sha=$(echo "$pr_json"     | jq -r '.headRefOid')
  state=$(echo "$pr_json"       | jq -r '.state')
  is_draft=$(echo "$pr_json"    | jq -r '.isDraft')
  head_ref=$(echo "$pr_json"    | jq -r '.headRefName')
  merge_state=$(echo "$pr_json" | jq -r '.mergeStateStatus')
  is_cross=$(echo "$pr_json"    | jq -r '.isCrossRepository')

  [ "$state" = "OPEN" ]     || { echo "PR #$pr is $state"; return 0; }
  [ "$is_draft" = "false" ] || { echo "PR #$pr is a draft"; return 0; }
  [ "$is_cross" = "false" ] || { echo "PR #$pr is from a fork (isCrossRepository=$is_cross)"; return 0; }
  case "$head_ref" in
    cursor/*) ;;
    *) echo "PR #$pr head is $head_ref, not cursor/"; return 0 ;;
  esac

  if [ -n "${HEAD_SHA:-}" ] && [ "$EVENT_NAME" != "schedule" ] && [ "$EVENT_NAME" != "workflow_dispatch" ]; then
    if [ "$cur_sha" != "$HEAD_SHA" ]; then
      echo "Stale run: PR #$pr head moved ($HEAD_SHA -> $cur_sha)"
      return 0
    fi
  fi

  if [ "$merge_state" != "CLEAN" ]; then
    echo "PR #$pr mergeStateStatus is $merge_state, not CLEAN"
    return 0
  fi

  checks=$(gh api --paginate "repos/$REPO/commits/$cur_sha/check-runs" \
    --jq '.check_runs[] | {name, status, conclusion}')

  filtered=$(printf '%s' "${checks:-}" | jq -s -c --argjson ex "$EXCLUDE_CHECKS" \
    '.[] | select((.name) as $n | ($ex | index($n)) | not)')

  if [ -z "$filtered" ]; then
    echo "No relevant check runs found for PR #$pr"
    return 0
  fi

  incomplete=$(printf '%s' "$filtered" | jq -s -r '.[] | select(.status != "completed") | .name')
  if [ -n "$incomplete" ]; then
    echo "PR #$pr still has checks running"
    return 0
  fi

  bugbot=$(printf '%s' "$filtered" | jq -s -c --arg n "$BUGBOT_CHECK" \
    '.[] | select(.name == $n)')
  if [ -z "$bugbot" ]; then
    echo "PR #$pr has no $BUGBOT_CHECK check; refusing (ruleset does not require it)"
    return 0
  fi
  bugbot_ok=$(printf '%s' "$bugbot" | jq -s -r \
    '.[] | select(.status == "completed" and .conclusion == "success") | .name')
  if [ -z "$bugbot_ok" ]; then
    echo "PR #$pr $BUGBOT_CHECK is not SUCCESS"
    printf '%s' "$bugbot" | jq -s -r '.[] | "  - \(.name): \(.status)/\(.conclusion // "n/a")"'
    return 0
  fi

  not_success=$(printf '%s' "$filtered" | jq -s -c '.[] | select(.conclusion != "success")')
  if [ -n "$not_success" ]; then
    echo "PR #$pr has a non-success check"
    printf '%s' "$not_success" | jq -s -r '.[] | "  - \(.name): \(.conclusion // "n/a")"'
    return 0
  fi

  status_json=$(gh api "repos/$REPO/commits/$cur_sha/status" \
    --jq '{state: .state, total: .total_count}')
  status_total=$(echo "$status_json" | jq -r '.total')
  status_state=$(echo "$status_json" | jq -r '.state')
  if [ "$status_total" -gt 0 ] && [ "$status_state" != "success" ]; then
    echo "PR #$pr commit statuses not all green (state=$status_state)"
    return 0
  fi

  unresolved=$(gh api graphql -f query='
    query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviewThreads(first:100) { nodes { isResolved } }
        }
      }
    }' -F owner="${REPO%/*}" -F repo="${REPO#*/}" -F pr="$pr" \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length')
  if [ "$unresolved" -gt 0 ]; then
    echo "PR #$pr has $unresolved unresolved review thread(s)"
    return 0
  fi
}

evaluate_pr() {
  local pr="$1"
  local reasons

  echo "Evaluating PR #$pr ..."
  reasons=$(gate_reasons "$pr")
  if [ -n "$reasons" ]; then
    echo "$reasons; skipping."
    return 0
  fi

  if [ "$POLL_SECONDS" -gt 0 ]; then
    echo "First CLEAN read for PR #$pr; waiting ${POLL_SECONDS}s for a second."
    sleep "$POLL_SECONDS"
  fi

  reasons=$(gate_reasons "$pr")
  if [ -n "$reasons" ]; then
    echo "Second read failed: $reasons; skipping."
    return 0
  fi

  echo "All checks green, Bugbot SUCCESS, mergeStateStatus CLEAN, no unresolved threads. Squash-merging PR #$pr."
  merge_with_retry "$pr"
}

PR_NUMBERS=""
case "$EVENT_NAME" in
  schedule|workflow_dispatch)
    PR_NUMBERS=$(gh pr list --repo "$REPO" --state open --limit 100 \
      --json number,headRefName,isDraft \
      --jq '.[] | select((.headRefName | startswith("cursor/")) and (.isDraft == false)) | .number')
    echo "Sweep: considering PR(s): ${PR_NUMBERS:-<none>}"
    ;;
  *)
    if [ -n "${HEAD_BRANCH:-}" ]; then
      PR_NUMBERS=$(gh pr list --repo "$REPO" --head "$HEAD_BRANCH" \
        --state open --json number --jq '.[0].number // empty')
    else
      PR_NUMBERS=$(gh api "repos/$REPO/commits/$HEAD_SHA/pulls" |
        jq -r --arg sha "$HEAD_SHA" \
          '[.[] | select(.state == "open" and .head.sha == $sha)][0].number // empty')
    fi
    ;;
esac

if [ -z "$PR_NUMBERS" ]; then
  echo "No candidate PRs for $EVENT_NAME (sha: ${HEAD_SHA:-<none>}, branch: ${HEAD_BRANCH:-<none>}); nothing to do."
  exit 0
fi

FAILED=0
for pr in $PR_NUMBERS; do
  echo "::group::PR #$pr"
  evaluate_pr "$pr" || FAILED=1
  echo "::endgroup::"
done

exit "$FAILED"
