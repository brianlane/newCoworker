#!/usr/bin/env bash
# e2e-scope.sh — spend guard for the live e2e job (paid Gemini calls).
# Decides WHICH of the tests/e2e/ suites a change can possibly affect, so a
# PR that only touches one AI surface pays for that surface's tests instead
# of the whole matrix. Replaces the older binary e2e-safe-paths.sh.
#
# Usage (needs GH_TOKEN):
#   e2e-scope.sh pr   <owner/repo> <pr-number>
#   e2e-scope.sh push <owner/repo> <sha> <before-sha>
#
# Emits to $GITHUB_OUTPUT:
#   skip=true|false   — true = ZERO paid model calls needed for this change
#   files=all | space-separated tests/e2e/*.e2e.test.ts paths
#
# Decision rules, in order of trust:
#   0. Admin cost toggle first: when Admin → Gemini has the CI e2e mode set
#      to "nightly-only" (read live from /api/public/ci-e2e-mode), every
#      per-change run skips the paid calls — the nightly cron is the only
#      live coverage and it emails the admin on failure. Any error reading
#      the mode falls through to per-change (rules below), never the other
#      way around.
#   1. Fail open. Any error listing files, any file that doesn't match a
#      mapping, an oversized diff, a force-push — anything surprising runs
#      the FULL suite. A mapping mistake can only waste a run, never lose
#      coverage of an unmapped surface... except through rule 2:
#   2. The mapping encodes IMPORTS, not vibes. Each scoped group below lists
#      exactly the e2e files that import from that production surface (see
#      the import audit in the PR that introduced this script). When an e2e
#      file gains an import from a new surface, add the path here — the
#      full-suite default covers you until then only for UNLISTED paths, so
#      keep the scoped patterns narrow.
#   3. Push-to-main dedupe: the merge commit of a squash-merged PR whose
#      branch was up to date has the IDENTICAL TREE as the PR head that the
#      e2e job already gated. Re-running the paid suite on it buys nothing —
#      skip when the trees match AND that PR's e2e check succeeded. Any
#      mismatch (branch was behind main, direct push, API error) falls back
#      to scoping the push diff. Dependabot merges are EXCLUDED from the
#      dedupe: their PR-side e2e is a secretless no-op SUCCESS, and the
#      push-to-main run is where dependency bumps get their real live-suite
#      coverage (see ci.yml) — their lockfile diffs scope to "all" anyway.
#   4. This is an in-job decision rather than a workflow `paths` filter on
#      purpose: the check must still report SUCCESS when it opts out or
#      narrows, because the merge policy treats a skipped/pending check as
#      blocking.
#
# The nightly full run (.github/workflows/e2e-nightly.yml) is the safety
# net for everything this trades away: live-model drift with no code change
# still surfaces within a day.

set -euo pipefail

MODE="$1"
REPO="$2"

# ---------------------------------------------------------------------------
# Scoped groups: e2e files keyed by the production surface they exercise.
# Membership = "imports from that surface" (directly or via a harness file).
# ---------------------------------------------------------------------------

# supabase/functions/_shared/ai_flows/** (engine, steps, branching,
# run_context, types) + the ai-flow-worker that executes them + the
# flow-walker/flow-run-replay harnesses built on those modules.
FLOW_TESTS="
tests/e2e/ai-flow-engine.e2e.test.ts
tests/e2e/ai-flow-steps.e2e.test.ts
tests/e2e/amy-act-now.e2e.test.ts
tests/e2e/bad-phone-classify.e2e.test.ts
tests/e2e/bug-hunt.e2e.test.ts
tests/e2e/bug-hunt-3.e2e.test.ts
tests/e2e/preferred-name-and-lifecycle.e2e.test.ts
tests/e2e/sms-duplicate-replies.e2e.test.ts
tests/e2e/truly-branch-matrix.e2e.test.ts
tests/e2e/truly-renewal-context.e2e.test.ts
"

# SMS prompt assembly in supabase/functions/_shared (reply_reasoning,
# sms_prompt_lines, customer_memory_preamble, contact_context,
# sms_transcript, datetime_line) + the sms-inbound-worker that composes them.
SMS_TESTS="
tests/e2e/amy-act-now.e2e.test.ts
tests/e2e/bug-hunt.e2e.test.ts
tests/e2e/bug-hunt-3.e2e.test.ts
tests/e2e/kyp-owner-sms-operator.e2e.test.ts
tests/e2e/kyp-timezone-context.e2e.test.ts
tests/e2e/preferred-name-and-lifecycle.e2e.test.ts
tests/e2e/reply-reasoning.e2e.test.ts
tests/e2e/sms-call-promise.e2e.test.ts
tests/e2e/sms-duplicate-replies.e2e.test.ts
tests/e2e/truly-human-handoff.e2e.test.ts
tests/e2e/truly-renewal-context.e2e.test.ts
"

# Dashboard/owner-SMS operator surface: OWNER_PREAMBLE, SMS_SURFACE_BLOCK,
# action tools, context blocks, the geminiChatStep engine step.
OPERATOR_TESTS="
tests/e2e/kyp-owner-sms-operator.e2e.test.ts
"

# Messenger/Instagram/WhatsApp + webchat customer engine.
MESSENGER_TESTS="
tests/e2e/messenger-engine.e2e.test.ts
"

# Voice bridge: system instruction + tool declarations.
VOICE_TESTS="
tests/e2e/voice-persona.e2e.test.ts
tests/e2e/voice-tools.e2e.test.ts
"

# The Truly Insurance production-flow fixture feeds two suites.
TRULY_FIXTURE_TESTS="
tests/e2e/truly-branch-matrix.e2e.test.ts
tests/e2e/truly-renewal-context.e2e.test.ts
"

SELECTED=""
FULL=false

add() { SELECTED="${SELECTED}
$1"; }

emit() { # emit <skip> <files> <message...>
  local skip="$1" files="$2"
  shift 2
  {
    echo "skip=${skip}"
    echo "files=${files}"
  } >> "$GITHUB_OUTPUT"
  echo "$*"
  exit 0
}

emit_full() { emit false all "$*"; }

# ---------------------------------------------------------------------------
# Admin cost toggle (Admin → Gemini → "CI live e2e"): when the platform's
# stored mode is "nightly-only", every per-change run skips the paid model
# calls entirely — live coverage comes from the nightly cron, which emails
# the admin on failure. Read from the production app so a flip needs no
# deploy; ANY error (endpoint down, non-JSON, timeout) falls through to the
# normal per-change scoping below, so an outage can never silently drop
# merge-time coverage. Overridable for tests via CI_E2E_MODE_URL.
# ---------------------------------------------------------------------------
MODE_URL="${CI_E2E_MODE_URL:-https://newcoworker.com/api/public/ci-e2e-mode}"
admin_mode=$(curl -fsS --max-time 10 "$MODE_URL" 2>/dev/null | jq -r '.mode // empty' 2>/dev/null) || admin_mode=""
if [ "${admin_mode:-}" = "nightly-only" ]; then
  emit true "" "CI e2e mode is nightly-only (admin toggle) — paid live calls run on the nightly cron instead."
fi

# scope_file <path> — accumulate the e2e files <path> can affect, or flip
# FULL for anything unmapped/self-referential. Ordering matters: overrides
# beat the broader safe globs (tests/e2e/* before tests/*, workflow files
# before .github/*, the bad-phone one-shot before scripts/*).
scope_file() {
  local f="$1"
  case "$f" in
    # --- e2e harness: shared plumbing runs everything; scoped harnesses
    #     run their group; a test file runs itself -------------------------
    tests/e2e/gemini.ts | tests/e2e/judge.ts) FULL=true ;;
    tests/e2e/usage-log.ts) ;; # token accounting only — asserts nothing
    tests/e2e/flow-walker.ts | tests/e2e/flow-run-replay.ts) add "$FLOW_TESTS" ;;
    tests/e2e/truly-privyr-flow.fixture.ts) add "$TRULY_FIXTURE_TESTS" ;;
    tests/e2e/*.e2e.test.ts) add "$f" ;;
    tests/e2e/*) FULL=true ;;

    # --- job definition / this script / nightly: full suite ---------------
    .github/workflows/ci.yml | .github/workflows/e2e-nightly.yml | \
    .github/scripts/e2e-gate.sh | .github/scripts/e2e-scope.sh | \
    .github/scripts/e2e-usage-summary.sh) FULL=true ;;

    # --- edge (voice IVR / SMS compliance) strings feed live prompts ------
    messages/edge-en.json | messages/edge-es.json) FULL=true ;;

    # --- the bad-phone one-shot exports the prompts its e2e test pins -----
    scripts/oneshot/add-bad-phone-agent-report*) add "tests/e2e/bad-phone-classify.e2e.test.ts" ;;

    # --- Safe: provably cannot change what the live suite exercises -------
    docs/* | PRDs/* | *.md) ;;                                     # documentation
    src/app/admin/* | src/components/admin/* | src/lib/admin/*) ;; # admin-only operator views
    src/app/about/* | src/app/compare/* | src/app/contact/* | src/app/faq/* | \
    src/app/features/* | src/app/industries/* | src/app/pricing/* | \
    src/app/privacy/* | src/app/terms/*) ;;                        # marketing/legal pages
    messages/en.json | messages/es.json) ;;                        # app-UI catalogs (edge-* is unsafe above)
    debug/* | scripts/*) ;;                                        # operator one-shots, not in the app bundle
    tests/*) ;;                                                    # unit tests (tests/e2e/* handled above)
    .cursor/* | .github/*) ;;                                      # repo meta (own workflow files handled above)

    # --- Scoped AI surfaces (import-audited, see header rule 2) -----------
    supabase/functions/_shared/ai_flows/*) add "$FLOW_TESTS" ;;
    supabase/functions/ai-flow-worker/*) add "$FLOW_TESTS" ;;
    supabase/functions/_shared/reply_reasoning* | \
    supabase/functions/_shared/sms_prompt_lines* | \
    supabase/functions/_shared/customer_memory_preamble* | \
    supabase/functions/_shared/contact_context* | \
    supabase/functions/_shared/sms_transcript* | \
    supabase/functions/_shared/datetime_line*) add "$SMS_TESTS" ;;
    supabase/functions/sms-inbound-worker/*) add "$SMS_TESTS" ;;
    src/lib/messenger/* | src/lib/webchat/*) add "$MESSENGER_TESTS" ;;
    src/lib/dashboard-chat/* | src/app/api/dashboard/chat/* | \
    src/app/api/internal/owner-sms-turn/*) add "$OPERATOR_TESTS" ;;
    src/lib/gemini-chat.ts) add "$OPERATOR_TESTS"; add "$MESSENGER_TESTS" ;;
    src/lib/ai-flows/*) add "$FLOW_TESTS" ;;
    vps/voice-bridge/*) add "$VOICE_TESTS" ;;

    # --- Anything else: run the full suite ---------------------------------
    *) FULL=true ;;
  esac
}

# ---------------------------------------------------------------------------
# Collect the changed files for this event.
# ---------------------------------------------------------------------------
files=""
if [ "$MODE" = "pr" ]; then
  PR="$3"
  files=$(gh api "repos/$REPO/pulls/$PR/files" --paginate -q '.[].filename') ||
    emit_full "Could not list PR files — running the full live suite (fail-open)."

elif [ "$MODE" = "push" ]; then
  SHA="$3"
  BEFORE="${4:-}"

  # --- Dedupe: identical tree to a merged PR whose e2e already passed ----
  dedupe() {
    local pr_head pr_user push_tree head_tree e2e_ok
    read -r pr_head pr_user < <(gh api "repos/$REPO/commits/$SHA/pulls" -q '
      [.[] | select(.merged_at != null and .merge_commit_sha == "'"$SHA"'")]
      | .[0] // empty | "\(.head.sha) \(.user.login)"' 2>/dev/null) || return 1
    [ -n "${pr_head:-}" ] && [ "$pr_head" != "null" ] || return 1
    # Dependabot PRs run a secretless no-op e2e — the push run is their
    # real coverage, so never dedupe them away.
    [ "$pr_user" != "dependabot[bot]" ] || return 1
    push_tree=$(gh api "repos/$REPO/git/commits/$SHA" -q .tree.sha) || return 1
    head_tree=$(gh api "repos/$REPO/git/commits/$pr_head" -q .tree.sha) || return 1
    [ -n "$push_tree" ] && [ "$push_tree" = "$head_tree" ] || return 1
    e2e_ok=$(gh api "repos/$REPO/commits/$pr_head/check-runs" --paginate -q '
      [.check_runs[] | select(.name == "E2E (live AI + AiFlows)"
        and .status == "completed" and .conclusion == "success")] | length' \
      | jq -s 'add // 0') || return 1
    [ "$e2e_ok" -gt 0 ] || return 1
    echo "$pr_head"
  }
  if pr_head=$(dedupe); then
    emit true "" "Identical tree to merged PR head ${pr_head}, whose e2e check already passed — skipping the paid live suite."
  fi

  # --- No dedupe: scope the push diff itself -----------------------------
  if [ -z "$BEFORE" ] || ! printf '%s' "$BEFORE" | grep -qv '^0*$'; then
    emit_full "No usable before-SHA (new branch or force push) — running the full live suite (fail-open)."
  fi
  compare=$(gh api "repos/$REPO/compare/$BEFORE...$SHA" 2>/dev/null) ||
    emit_full "Could not compare $BEFORE...$SHA — running the full live suite (fail-open)."
  # Fail-open on ANY unusable compare payload: `.files // []` absorbs a
  # missing/null array, and a jq parse error (non-JSON body) falls to
  # emit_full instead of dying under set -e.
  count=$(jq '(.files // []) | length' <<<"$compare" 2>/dev/null) ||
    emit_full "Could not parse the compare response — running the full live suite (fail-open)."
  # The compare API caps .files at 300 — a bigger diff is only partially
  # visible, so scope decisions on it would be unsound.
  if [ "$count" -ge 300 ]; then
    emit_full "Push diff has ${count}+ files (compare API cap) — running the full live suite (fail-open)."
  fi
  files=$(jq -r '(.files // [])[].filename' <<<"$compare" 2>/dev/null) ||
    emit_full "Could not parse the compare response — running the full live suite (fail-open)."

else
  emit_full "Unknown mode '$MODE' — running the full live suite (fail-open)."
fi

if [ -z "$files" ]; then
  emit_full "Empty file list — running the full live suite (fail-open)."
fi

# ---------------------------------------------------------------------------
# Map every changed file, then emit the union.
# ---------------------------------------------------------------------------
while IFS= read -r f; do
  [ -n "$f" ] || continue
  scope_file "$f"
  if [ "$FULL" = true ]; then
    emit_full "AI-relevant change outside the scoped map: $f — running the full live suite."
  fi
done <<< "$files"

# `grep -v` exits 1 when nothing survives (the all-safe case) — that is a
# valid outcome, not an error, so neutralize it under set -e/pipefail.
selected=$(printf '%s\n' "$SELECTED" | { grep -v '^$' || true; } | sort -u | tr '\n' ' ' | sed 's/ $//')
if [ -z "$selected" ]; then
  emit true "" "Every changed file is on the safe-path allowlist — skipping the paid live suite."
fi
emit false "$selected" "Scoped live suite for this change: $selected"
