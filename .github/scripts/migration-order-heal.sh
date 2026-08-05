#!/usr/bin/env bash
# migration-order-heal.sh: close the post-approval merge window that the
# PR-time stamp guard cannot see.
#
# The race: a PR's migration stamp is valid when Supabase Drift Check runs,
# then another PR's migration merges first and moves the applied ledger head.
# The first PR's file now sorts below the head, so the push-to-main deploy
# fails at `supabase db push` and production stops receiving merges until a
# human re-stamps (PR #1066's 20260822023338 vs #1064's 20260822025852 on
# 2026-07-31, repaired by hand in #1068). No PR-time check can close this:
# the collision is created by the merge ORDER of two PRs that were both
# green, so the last safe moment to fix the ordering is right here, at
# deploy time, against the live applied ledger.
#
# What this script does, run by supabase-deploy.sh in deploy mode before
# `supabase db push`:
#
#   1. Fetches the live tip of origin/main and syncs the checkout's
#      supabase/migrations/ to it (the run may be at an older commit than
#      the tip when a prior heal commit landed after this run's SHA).
#   2. Reads the ledger of APPLIED versions via `supabase migration list`.
#   3. Finds local files whose version is NOT in the ledger yet sorts at or
#      below the applied head: exactly the merge-window casualties.
#   4. Renames them (git mv, content preserved) to fresh stamps above
#      max(applied head, local head, real UTC), commits that rename onto the
#      fetched tip in a temporary worktree, and pushes it to main. The
#      commit message carries [skip ci] so the push starts no new workflow
#      run regardless of auth (a GITHUB_TOKEN push never does; a deploy-key
#      push WOULD, and cancel-in-progress would let that new run cancel this
#      deploy mid-flight); THIS run then applies the healed files and
#      deploys.
#   5. Mirrors the renames into the run's checkout so the `db push` that
#      follows sees the healed names.
#
# What it will never do:
#   - Rename a file whose version IS in the remote ledger. The filename must
#     keep matching the applied row (supabase/migrations/CLAUDE.md rule 2).
#   - Touch the ledger. `supabase migration repair` stays a deliberate
#     human/agent action; this script only renames not-yet-applied files.
#   - Guess. Duplicate versions on main fail the deploy loudly (which file
#     owns the ledger row is not decidable from names), and ledger versions
#     with no local file skip the heal so `db push` reports the drift with
#     its own error text.
#
# Expected env: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD (for the ledger
# read; the CLI is already linked by supabase-deploy.sh), plus the
# actions/checkout git credentials for the push (persist-credentials).
#
# Push auth vs the main ruleset: the branch ruleset "main: PRs with all
# checks green" (Aug 2026) blocks direct pushes to main, and GitHub will not
# accept its own Actions app as a bypass actor on a user-owned repo, so a
# GITHUB_TOKEN push here would be rejected. The bypass list instead exempts
# DEPLOY KEYS, and ci.yml passes this script MIGRATION_HEAL_SSH_KEY (an
# Actions secret holding the private half of the write deploy key titled
# "migration-order-heal"; the key id changes on rotation, and the local
# .env keeps a base64 copy as MIGRATION_HEAL_SSH_KEY_B64) plus
# MIGRATION_HEAL_PUSH_URL (the repo's SSH URL). When both are set, the re-stamp push authenticates with that key
# and sails through the bypass; when unset (local runs, the vitest sandbox),
# the push falls back to plain `origin`, same as before the ruleset existed.
set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"
MAX_ATTEMPTS=3
BOT_NAME="github-actions[bot]"
BOT_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"

# Push the healed tip to main, choosing auth by environment (see header).
# Usage: push_main <worktree>. Returns git push's own exit code.
push_main() {
  local wt="$1"
  if [ -n "${MIGRATION_HEAL_SSH_KEY:-}" ] && [ -n "${MIGRATION_HEAL_PUSH_URL:-}" ]; then
    local key_file rc
    key_file=$(mktemp)
    printf '%s\n' "$MIGRATION_HEAL_SSH_KEY" > "$key_file"
    chmod 600 "$key_file"
    rc=0
    GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
      git -C "$wt" push "$MIGRATION_HEAL_PUSH_URL" HEAD:refs/heads/main --quiet || rc=$?
    rm -f "$key_file"
    return "$rc"
  fi
  git -C "$wt" push origin HEAD:refs/heads/main --quiet
}

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::$MIGRATIONS_DIR not found. Run this from the repo root."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "::error::python3 is required for the stamp arithmetic."
  exit 1
fi

# Same shallow-awareness as migration-stamp-guard.sh: --depth=1 is right when
# the repo is already shallow (CI), and truncates history when it is not.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  fetch_main() { git fetch --depth=1 origin main --quiet 2>/dev/null; }
else
  fetch_main() { git fetch origin main --quiet 2>/dev/null; }
fi

# Applied versions only: the second (REMOTE) column of the pinned CLI's
# `migration list` table. Local-only rows leave that column blank. The parse
# is deliberately strict (exactly 14 digits after stripping spaces) so a
# format change in an unpinned future CLI yields an empty set, which skips
# the heal rather than renaming on bad data.
read_applied() {
  supabase migration list 2>/dev/null \
    | awk -F'|' 'NF >= 2 { v = $2; gsub(/[[:space:]]/, "", v); if (v ~ /^[0-9]{14}$/) print v }' \
    | sort -u
}

WT=""
cleanup_wt() {
  if [ -n "$WT" ]; then
    git worktree remove --force "$WT" >/dev/null 2>&1 || true
    git worktree prune >/dev/null 2>&1 || true
    rm -rf "$(dirname "$WT")"
    WT=""
  fi
}
trap cleanup_wt EXIT

attempt=1
while :; do
  if ! fetch_main; then
    echo "::warning::could not fetch origin/main; skipping the order heal (db push still guards)."
    exit 0
  fi

  # Sync the checkout's migrations dir to the live tip. rm-then-checkout
  # because `git checkout <commit> -- <dir>` restores files but does not
  # delete ones absent from that commit, and a stale pre-heal filename left
  # behind would re-break the very push this script protects.
  rm -f "$MIGRATIONS_DIR"/*.sql
  git checkout FETCH_HEAD -- "$MIGRATIONS_DIR"

  applied=$(read_applied || true)
  if [ -z "$applied" ]; then
    echo "::warning::could not read the applied ledger; skipping the order heal (db push still guards)."
    exit 0
  fi
  applied_head=$(printf '%s\n' "$applied" | tail -1)

  files=$(ls -1 "$MIGRATIONS_DIR" | grep '\.sql$' | sort)
  versions=$(printf '%s\n' "$files" | cut -d_ -f1 | sort)

  dups=$(printf '%s\n' "$versions" | uniq -d)
  if [ -n "$dups" ]; then
    echo "::error::duplicate migration version stamp(s) on main:"
    echo "$dups"
    echo "Auto-heal refuses to guess which file owns the ledger row."
    echo "Re-stamp the unapplied file manually per supabase/migrations/CLAUDE.md."
    exit 1
  fi

  missing=$(comm -23 <(printf '%s\n' "$applied") <(printf '%s\n' "$versions" | uniq))
  if [ -n "$missing" ]; then
    echo "::warning::remote ledger version(s) with no local file:"
    echo "$missing"
    echo "Skipping the order heal so db push reports the drift itself."
    exit 0
  fi

  # The merge-window casualties: pending (not in the ledger) yet sorting at
  # or below the applied head. String comparison is safe: stamps are
  # fixed-width digit strings.
  to_heal=""
  while IFS= read -r f; do
    v="${f%%_*}"
    if printf '%s\n' "$applied" | grep -qx "$v"; then
      continue # applied: the filename must keep matching the ledger row
    fi
    if [ "$v" \< "$applied_head" ] || [ "$v" = "$applied_head" ]; then
      to_heal="${to_heal}${f}"$'\n'
    fi
  done <<< "$files"
  to_heal=$(printf '%s' "$to_heal" | grep -v '^$' || true)

  if [ -z "$to_heal" ]; then
    echo "Migration order heal: nothing to do (no pending migration sorts below the applied head $applied_head)."
    exit 0
  fi

  echo "Migration order heal: pending migration(s) below the applied head $applied_head:"
  printf '%s\n' "$to_heal" | sed 's/^/  /'

  local_head=$(printf '%s\n' "$versions" | tail -1)

  # New stamps above max(applied head, local head, real UTC), one random
  # 60..1800s step per file, preserving the files' relative order. Same
  # arithmetic family as scripts/new-migration.sh.
  renames=$(printf '%s\n' "$to_heal" | python3 -c '
import datetime, random, sys

FMT = "%Y%m%d%H%M%S"
local_head, applied_head = sys.argv[1], sys.argv[2]
now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)
base = max(
    datetime.datetime.strptime(local_head, FMT),
    datetime.datetime.strptime(applied_head, FMT),
    now,
)
for line in sys.stdin:
    old = line.strip()
    if not old:
        continue
    base += datetime.timedelta(seconds=random.randint(60, 1800))
    name = old.split("_", 1)[1]
    print(f"{old} {base.strftime(FMT)}_{name}")
' "$local_head" "$applied_head")

  # Build the rename commit on the fetched tip in a temp worktree, never on
  # this run's (possibly older) checkout SHA: pushing a commit forked from
  # an older SHA would be rejected as non-fast-forward whenever a prior heal
  # commit already sits on main.
  WT=$(mktemp -d)/heal-wt
  git worktree add --detach "$WT" FETCH_HEAD >/dev/null 2>&1

  while IFS=' ' read -r old new; do
    if [ ! -s "$WT/$MIGRATIONS_DIR/$old" ]; then
      echo "::error::$old is empty or missing at the tip; refusing to re-stamp it (see the empty-scaffold trap in supabase/migrations/CLAUDE.md)."
      exit 1
    fi
    git -C "$WT" mv "$MIGRATIONS_DIR/$old" "$MIGRATIONS_DIR/$new"
    if [ ! -s "$WT/$MIGRATIONS_DIR/$new" ]; then
      echo "::error::$new lost its content during the rename; aborting before anything is pushed."
      exit 1
    fi
    echo "  $old -> $new"
  done <<< "$renames"

  # [skip ci] matters on the deploy-key path: unlike a GITHUB_TOKEN push,
  # a deploy-key push DOES start a new push-event workflow run, and CI's
  # cancel-in-progress concurrency group would let that new run cancel the
  # very deploy performing this heal before db push finishes. Suppressing
  # the run restores the old GITHUB_TOKEN behavior: the heal commit rides
  # to main with no run of its own, and THIS run completes the deploy.
  msg="Re-stamp unapplied migration(s) above the applied ledger head [order heal] [skip ci]

$(printf '%s\n' "$renames" | sed 's/ / -> /')

Automated by .github/scripts/migration-order-heal.sh during the push-to-main
deploy. The stamp(s) were valid when their PR was checked; a migration from
another PR merged first and moved the applied head, so these files sorted
below it at deploy time. Only files absent from the remote ledger are ever
renamed; the ledger itself is never touched."

  git -C "$WT" -c user.name="$BOT_NAME" -c user.email="$BOT_EMAIL" commit -m "$msg" --quiet

  if push_main "$WT"; then
    cleanup_wt
    # Mirror into the run's checkout (already synced to the pre-heal tip
    # above) so the db push that follows applies the healed names.
    while IFS=' ' read -r old new; do
      mv "$MIGRATIONS_DIR/$old" "$MIGRATIONS_DIR/$new"
    done <<< "$renames"
    echo "Migration order heal: rename(s) pushed to main; continuing the deploy with the healed files."
    exit 0
  fi

  cleanup_wt
  attempt=$((attempt + 1))
  if [ "$attempt" -gt "$MAX_ATTEMPTS" ]; then
    echo "::error::could not push the re-stamp commit to main after $MAX_ATTEMPTS attempts (main kept moving). Re-run this job; the heal recomputes from the live tip each time."
    exit 1
  fi
  echo "push to main rejected (tip moved); retrying with a fresh fetch (attempt $attempt of $MAX_ATTEMPTS)..."
done
