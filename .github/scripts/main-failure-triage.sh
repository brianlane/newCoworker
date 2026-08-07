#!/usr/bin/env bash
# main-failure-triage.sh: decide whether a failed push-to-main CI run gets
# another automatic retry or wakes a human, and send the email when it is the
# latter. Run by main-failure-watch.yml; see that file's header for why a
# failed push-to-main run is urgent.
#
# The rule this replaces was "failed twice on fresh runners, therefore real".
# That assumes the SAME cause reproduced, and on 2026-08-06 it did not
# (run 31068979036, the #1209 merge):
#
#   attempt 1  supabase db push   dial tcp [2600:...]:5432: network is unreachable
#   attempt 2  supabase link      Unexpected error retrieving remote project status: error code: 502
#   attempt 3  (manual)           green
#
# Two unrelated transient Supabase failures 30 seconds apart, reported as one
# real bug, and a human had to run attempt 3 by hand. Note what does NOT
# separate those two: same job ("Vercel Deploy"), same step ("Apply migrations
# + deploy edge functions"), and byte-identical `##[error]` markers
# ("Process completed with exit code 1"). Only the lines LEADING UP TO the
# error differ, so that window is what gets compared.
#
# Policy:
#   - attempt 1 fails                      re-run the failed jobs
#   - attempt 2 fails, cause MATCHES       email now (a real failure earns no
#                                          extra delay: same as the old rule)
#   - attempt 2 fails, cause DIFFERS       re-run once more, then stop
#   - attempt 3+ fails                     email, whatever the causes
#   - success at any point                 silence
#
# Being wrong about "differs" is deliberately cheap: a false differ costs one
# extra run and still alerts at attempt 3, while a false match just alerts one
# run early, which is the old behavior. When the signatures cannot be read at
# all, that reads as MATCH so the human is woken rather than the run being
# retried forever.
#
# Expected env: GH_TOKEN, RUN_ID, RUN_ATTEMPT, RUN_URL, RUN_TITLE, REPO, and
# RESEND_API_KEY to actually send.
set -uo pipefail

: "${RUN_ID:?RUN_ID is required}"
: "${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
: "${REPO:?REPO is required}"
RUN_URL="${RUN_URL:-}"
RUN_TITLE="${RUN_TITLE:-}"

# Attempt at which we stop retrying and always email.
ALERT_AT_ATTEMPT="${ALERT_AT_ATTEMPT:-3}"
# Lines of context kept ahead of the first error marker.
CONTEXT_LINES="${CONTEXT_LINES:-15}"

# A literal ESC, written this way because BSD sed (macOS, where the tests also
# run) does not understand the \x1b escape that GNU sed accepts.
ESC=$(printf '\033')

# Strip timestamps and ANSI colour, drop blank lines, then keep the window
# ending at the FIRST error marker. Falls back to the log tail when a job died
# without one (a cancelled or timed-out step).
error_context() {
  local clean first gline start window
  clean=$(sed -E -e "s/${ESC}\\[[0-9;]*m//g" -e 's/^[0-9][0-9T:.Z+-]{10,} //' | grep -v '^[[:space:]]*$')
  [ -z "$clean" ] && return 0

  first=$(grep -n '##\[error\]' <<<"$clean" | head -1 | cut -d: -f1)
  if [ -z "$first" ]; then
    # No marker (a cancelled or timed-out step): the tail is the best guess.
    window=$(printf '%s\n' "$clean" | tail -"$CONTEXT_LINES")
  else
    # Start at the FAILING STEP, not a fixed number of lines back. A fixed
    # window reaches into whatever ran before, and the setup actions differ
    # between attempts for reasons that have nothing to do with the failure:
    # on the real 2026-08-06 run, attempt 1 downloaded Bun while attempt 2
    # logged "Using a cached version of Bun". Comparing that would report
    # DIFFERENT for every attempt-1-versus-2 pair and retry even a failure
    # that is plainly repeating.
    gline=$(printf '%s\n' "$clean" | head -n "$first" | grep -n '^[[:space:]]*##\[group\]' | tail -1 | cut -d: -f1)
    start=$(( ${gline:-0} + 1 ))
    # Still bounded, so one enormous step cannot dominate the comparison.
    [ $(( first - start + 1 )) -gt "$CONTEXT_LINES" ] && start=$(( first - CONTEXT_LINES + 1 ))
    [ "$start" -lt 1 ] && start=1
    window=$(sed -n "${start},${first}p" <<<"$clean")
  fi

  # The group header echoes the whole env block ("SUPABASE_ACCESS_TOKEN: ***",
  # "NODE_VERSION: 24", ...). Those vary on their own and would crowd out the
  # real message, so they go. Dropped by shape rather than by naming any one
  # tool's chatter.
  printf '%s\n' "$window" | awk '
      /^[[:space:]]*##\[(group|endgroup)\]/ { next }
      /^[[:space:]]*env:[[:space:]]*$/ { next }
      /^[[:space:]]*shell: / { next }
      # Real messages that happen to be shouted keep their place. The coverage
      # gate opens exactly this way ("ERROR: Coverage for branches (99.99%)
      # does not meet global threshold"), and dropping it would make two
      # unrelated coverage failures indistinguishable.
      /^[[:space:]]*(ERROR|FATAL|WARNING|WARN|FAIL|FAILED|NOTICE|HINT|DETAIL):/ { print; next }
      # Everything else shaped like SCREAMING_NAME: value is that env block.
      /^[[:space:]]*[A-Z][A-Z0-9_]+: / { next }
      { print }
    '
}

# Blank out the values that legitimately differ between two runs of the SAME
# failure (ids, addresses, byte counts, durations) so only the shape of the
# message decides. Over-normalising is the safe direction here: it can merge
# two genuinely different errors into one "match", which alerts a run early.
# Addresses are collapsed as a CLASS before the digit pass. An IPv6 group is
# four hex characters, so neither a long-hex rule nor a digits rule flattens
# two addresses to the same text: 2600:1f16:... and 2600:9999:... would read
# as two different failures when they are one failure dialling a rotated
# address.
normalize() {
  sed -E -e 's/\[[0-9a-fA-F:]{6,}\]/[IPV6]/g' \
         -e 's/([0-9a-fA-F]{1,4}:){4,}[0-9a-fA-F]{0,4}/IPV6/g' \
         -e 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/IPV4/g' \
         -e 's/[0-9a-f]{8,}/HEX/g' \
         -e 's/[0-9]+/N/g' \
         -e 's/[[:space:]]+/ /g' \
         -e 's/^ //' -e 's/ $//'
}

# The comparable fingerprint of one attempt: the error window of every failed
# job, normalised, order-independent. Empty output means "could not read".
attempt_signature() {
  local attempt="$1" jobs ids id log out=""
  jobs=$(gh api "repos/$REPO/actions/runs/$RUN_ID/attempts/$attempt/jobs" --paginate 2>/dev/null) || return 0
  ids=$(jq -rs '[.[].jobs[]? | select(.conclusion == "failure") | .id] | .[]' <<<"$jobs" 2>/dev/null) || return 0
  [ -z "$ids" ] && return 0
  for id in $ids; do
    log=$(gh api "repos/$REPO/actions/jobs/$id/logs" 2>/dev/null) || continue
    [ -z "$log" ] && continue
    out="${out}$(printf '%s' "$log" | error_context | normalize)"$'\n'
  done
  printf '%s' "$out" | grep -v '^[[:space:]]*$' | sort -u
}

rerun_failed_jobs() {
  echo "push-to-main run $RUN_ID failed on attempt $RUN_ATTEMPT: $1"
  gh api -X POST "repos/$REPO/actions/runs/$RUN_ID/rerun-failed-jobs"
}

if [ "$RUN_ATTEMPT" -lt 2 ]; then
  rerun_failed_jobs "re-running the failed jobs (a first failure is assumed transient)."
  exit 0
fi

# One comparison, only at the attempt where the answer changes what happens.
CAUSE_NOTE=""
if [ "$RUN_ATTEMPT" -lt "$ALERT_AT_ATTEMPT" ]; then
  prev=$(attempt_signature "$(( RUN_ATTEMPT - 1 ))")
  curr=$(attempt_signature "$RUN_ATTEMPT")
  if [ -n "$prev" ] && [ -n "$curr" ] && [ "$prev" != "$curr" ]; then
    echo "attempt $(( RUN_ATTEMPT - 1 )) and attempt $RUN_ATTEMPT failed for DIFFERENT reasons:"
    echo "--- previous ---"; printf '%s\n' "$prev" | head -20
    echo "--- current ---";  printf '%s\n' "$curr" | head -20
    rerun_failed_jobs "the two failures do not match, which reads as independent transient failures rather than one real bug. Retrying once more."
    exit 0
  fi
  if [ -z "$prev" ] || [ -z "$curr" ]; then
    echo "could not read one or both attempt signatures; treating as a repeat failure and alerting."
    CAUSE_NOTE=" The two attempts could not be compared (their logs were unreadable), so this is being reported as a repeat failure."
  else
    CAUSE_NOTE=" Both attempts failed the same way, so this is a repeat of one failure rather than unrelated blips."
  fi
else
  CAUSE_NOTE=" This is attempt $RUN_ATTEMPT, past the point where retrying is worth more delay."
fi

echo "push-to-main run $RUN_ID failed on attempt $RUN_ATTEMPT: alerting."
if [ -z "${RESEND_API_KEY:-}" ]; then
  echo "::warning::RESEND_API_KEY secret is not set: cannot email the admin. Set it (gh secret set RESEND_API_KEY) or watch the Actions tab."
  exit 0
fi

# The wording must match what ACTUALLY happened (Bugbot on PR #864, twice):
# the e2e job runs AFTER Vercel Deploy on push runs, so a run can fail with
# production fully updated, but a run can ALSO fail upstream, leaving Vercel
# Deploy SKIPPED (not failed), in which case production did NOT update
# either. The only state that earns the calmer wording is the Vercel Deploy
# job concluding literally "success"; every other shape, failure, skipped,
# cancelled, missing, or an error listing the jobs, reads as a blocked deploy
# (the scarier reading is the safe default for a human to verify).
jobs_json=$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?filter=latest" --paginate 2>/dev/null) || jobs_json=""
deploy_conclusion=$(jq -rs '[.[].jobs[]? | select(.name == "Vercel Deploy")] | last | .conclusion // "unknown"' <<<"$jobs_json" 2>/dev/null) || deploy_conclusion="unknown"
failed_jobs=$(jq -rs '[.[].jobs[]? | select(.conclusion == "failure") | .name] | unique | join(", ")' <<<"$jobs_json" 2>/dev/null) || failed_jobs=""
if [ "$deploy_conclusion" = "success" ]; then
  SUBJECT="Main CI failed $RUN_ATTEMPT times after deploy: $RUN_TITLE"
  DETAIL="The Vercel Deploy job succeeded, production IS updated, but a post-deploy job failed on every attempt: ${failed_jobs:-unknown}. Treat a failed live e2e here as a possible AI regression that just shipped."
else
  SUBJECT="Main deploy failed $RUN_ATTEMPT times, production did not update: $RUN_TITLE"
  DETAIL="Until this run is green, production has NOT received this merge: pending migrations, edge functions, and the Vercel app deploy are all blocked (they ride the Vercel Deploy job, whose conclusion on this run is: ${deploy_conclusion}). Failed jobs: ${failed_jobs:-unknown}."
fi
BODY=$(jq -n \
  --arg url "$RUN_URL" \
  --arg subject "$SUBJECT" \
  --arg detail "$DETAIL" \
  --arg cause "$CAUSE_NOTE" \
  --arg attempts "$RUN_ATTEMPT" '{
  from: "New Coworker <contact@newcoworker.com>",
  to: ["team@newcoworker.com"],
  subject: $subject,
  text: ("The push-to-main CI run failed " + $attempts + " times, counting the automatic re-runs." + $cause + "\n\nRun: " + $url + "\n\n" + $detail + " Read the failed job log, fix or revert, and re-run.\n\nCI (main-failure-watch.yml)")
}')
curl -fsS https://api.resend.com/emails \
  -H "Authorization: Bearer ${RESEND_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$BODY" > /dev/null && echo "Failure email sent to team@newcoworker.com" || \
  echo "::warning::Failure email could not be sent (Resend API error): check the Actions tab."
