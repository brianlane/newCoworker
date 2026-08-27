#!/usr/bin/env bash
# new-migration.sh: create a migration file with a version stamp that is safe
# to merge in parallel with other branches.
#
# Usage: bash scripts/new-migration.sh <snake_case_name>
#
# WHY THIS EXISTS INSTEAD OF `date -u +%Y%m%d%H%M%S`
#
# A stamp has to satisfy two things at once: sort AFTER every migration
# already applied to production (or `supabase db push` refuses to apply it in
# order, and a fresh `supabase start` runs it before the migration that
# creates the objects it touches), and be unique against branches you cannot
# see. Real UTC time satisfies both, normally.
#
# It does not today. This repo's applied stamps run about 26 days ahead of the
# wall clock: the head is in late August 2026 while the clock reads late July.
# A literal `date -u` stamp therefore sorts BEHIND the head and breaks both
# things above, which is exactly why people have been hand-inventing stamps,
# and hand-invented stamps are what collided three times on 2026-07-26
# (PRs #932/#934, #938/#939) and twice on 2026-07-14 (PRs #600/#601).
#
# So this script emits `max(real UTC, head + a small random offset)`:
#
#   - While the clock is behind the head, it lands just above the head. The
#     head crawls forward by minutes a day while real time advances a full
#     day, so the gap CLOSES. The random offset is what keeps two parallel
#     branches from drawing the same value.
#   - Once real time passes the head (around 2026-08-21, sooner per the gap
#     above if stamps stay tightly packed), the first branch of the max wins
#     and this script starts emitting true timestamps on its own. Nothing
#     needs renaming and the production ledger is never repaired: the
#     convention converges instead of being migrated.
#
# The head is read from the union of your working tree and origin/main, so a
# branch cut before someone else's migration merged still stamps above it.
# A branch that goes stale AFTER this runs is caught at review time by
# .github/scripts/migration-stamp-guard.sh.
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: bash scripts/new-migration.sh <snake_case_name>" >&2
  echo "example: bash scripts/new-migration.sh add_booking_reminder_window" >&2
  exit 1
fi

if ! printf '%s' "$NAME" | grep -Eq '^[a-z][a-z0-9_]*$'; then
  echo "::error::name must be snake_case (lowercase letters, digits, underscores): got '$NAME'" >&2
  exit 1
fi

MIGRATIONS_DIR="supabase/migrations"
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::$MIGRATIONS_DIR not found. Run this from the repo root." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "::error::python3 is required for the stamp arithmetic." >&2
  exit 1
fi

local_head=$(ls -1 "$MIGRATIONS_DIR" | grep '\.sql$' | cut -d_ -f1 | sort | tail -1 || true)

# Best effort: offline or a missing remote just means we stamp above the
# local head, and the CI guard remains the backstop.
#
# NEVER `--depth=1` here without checking. This script runs on developer
# machines with complete clones, and a shallow fetch TRUNCATES the local
# history: git writes .git/shallow, after which origin/main appears to share
# no ancestor with your branch and the repo reports thousands of phantom
# "ahead" commits (done to this repo on 2026-07-26; repaired with
# `git fetch --unshallow`). Shallow-fetch only a repo that is already shallow.
remote_head=""
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  fetch_main() { git fetch --depth=1 origin main --quiet 2>/dev/null; }
else
  fetch_main() { git fetch origin main --quiet 2>/dev/null; }
fi

if fetch_main; then
  remote_head=$(git ls-tree --name-only FETCH_HEAD -- "$MIGRATIONS_DIR/" 2>/dev/null \
    | sed 's#.*/##' | grep '\.sql$' | cut -d_ -f1 | sort | tail -1 || true)
else
  echo "note: could not read origin/main, stamping above the local head only." >&2
fi

head=$(printf '%s\n%s\n' "$local_head" "$remote_head" | grep -v '^$' | sort | tail -1 || true)
now=$(date -u +%Y%m%d%H%M%S)

stamp=$(python3 - "$head" "$now" <<'PY'
import datetime, random, sys

FMT = "%Y%m%d%H%M%S"
head, now = sys.argv[1], sys.argv[2]
now_dt = datetime.datetime.strptime(now, FMT)

if not head:
    print(now)
    raise SystemExit(0)

head_dt = datetime.datetime.strptime(head, FMT)
if now_dt > head_dt:
    # The wall clock has overtaken the invented series. Real timestamps from
    # here on, which is the end state this script exists to reach.
    print(now)
else:
    # Just above the head. The offset stays small because the gap closes
    # faster the less the head moves: at this repo's rate the head gains
    # minutes a day against real time's full day. The window is still wide
    # enough that two branches stamping at once rarely draw the same second,
    # and the CI guard catches the rare pair that does.
    print((head_dt + datetime.timedelta(seconds=random.randint(60, 1800))).strftime(FMT))
PY
)

FILE="$MIGRATIONS_DIR/${stamp}_${NAME}.sql"
if [ -e "$FILE" ]; then
  echo "::error::$FILE already exists. Re-run to draw a different offset." >&2
  exit 1
fi

: > "$FILE"

echo "Created $FILE"
if [ -n "$head" ] && [ "$stamp" != "$now" ]; then
  echo "  (stamped above the current head $head; real UTC is $now and has not caught up yet)"
else
  echo "  (real UTC stamp: the wall clock is now past the head)"
fi
echo ""
echo "This file is EMPTY. If you are re-stamping a stale migration, MOVE the"
echo "SQL from the old file into this one and verify with 'wc -c' before"
echo "deleting the old copy (PR #1077 shipped a zero-byte migration by"
echo "skipping that; tests/migration-not-empty.test.ts now fails the PR)."
echo ""
echo "Remember: objects created here get NO Data API grants automatically."
echo "Grant service_role in this same file, or add a '-- grants: none (<name>): reason'"
echo "marker. See .cursor/rules/migration-grants.mdc."
