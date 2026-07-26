#!/usr/bin/env bash
# migration-stamp-guard.sh: fail a PR that would put two different migration
# files on the same version stamp.
#
# Why this exists: Supabase records each applied migration in
# supabase_migrations.schema_migrations keyed by version, so two files sharing
# a version prefix are a duplicate-key error the moment anything applies them
# in order. That breaks `supabase start` / `supabase db reset` repo-wide AND
# the push-to-main deploy, which means production stops receiving merges until
# someone restamps.
#
# The failure mode is a race, not a typo: two branches each pick a stamp while
# neither can see the other's file, both go green, and the second merge is what
# breaks main (PRs #600/#601 on 2026-07-14, PRs #932/#934 on 2026-07-26). This
# guard compares the PR against the CURRENT tip of main rather than only the
# checked-out tree, so a PR branch that is stale relative to a just-merged
# migration goes red at review time instead of after the merge.
#
# Residual gap, stated honestly: two PRs that are BOTH open before either one
# merges still cannot see each other, so the first merge can still hand the
# second a collision. Re-running this check after that merge catches it (the
# e2e gate's poll is a natural re-run point), and the post-merge worker
# integration job plus main-failure-watch.yml remain the backstop.
#
# Usage: migration-stamp-guard.sh [base-branch]   (default: main)
set -euo pipefail

BASE="${1:-main}"
MIGRATIONS_DIR="supabase/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::$MIGRATIONS_DIR not found. Run this from the repo root."
  exit 1
fi

# The checkout is shallow (fetch-depth 1) and, on a pull_request event, is the
# merge commit. Fetching the base explicitly is what makes the comparison
# reflect main as it is RIGHT NOW rather than whenever the merge ref was built.
#
# Depth matters here. `--depth=1` is right in CI, where actions/checkout has
# already made the repo shallow, but running it against a COMPLETE clone
# truncates that clone's history: git writes .git/shallow, after which
# origin/<base> appears to share no ancestor with your branch and the repo
# reports thousands of phantom "ahead" commits (observed on 2026-07-26 while
# testing this script locally; the repair is `git fetch --unshallow`). So ask
# the repo what it is rather than assuming CI.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  fetch_base() { git fetch --depth=1 origin "$1" --quiet 2>/dev/null; }
else
  fetch_base() { git fetch origin "$1" --quiet 2>/dev/null; }
fi

if ! fetch_base "$BASE"; then
  echo "::warning::could not fetch origin/$BASE, checking the checked-out tree only."
  base_files=""
else
  base_files=$(git ls-tree --name-only FETCH_HEAD -- "$MIGRATIONS_DIR/" \
    | sed 's#.*/##' | grep '\.sql$' || true)
fi

pr_files=$(ls -1 "$MIGRATIONS_DIR" | grep '\.sql$' || true)

# Union by FILENAME: a file present unchanged on both sides is one entry, so
# only genuinely different files sharing a version prefix are reported. A PR
# that restamps a migration lands as two entries under two different
# prefixes, which is exactly the fix for this failure and stays green.
# The input is sorted, so tracking first-seen order keeps each version's
# files grouped under it (awk's `for (v in array)` order is unspecified, and
# sorting the rendered block would separate a header from its own files).
collisions=$(printf '%s\n%s\n' "$base_files" "$pr_files" \
  | grep -v '^[[:space:]]*$' \
  | sort -u \
  | awk '
      {
        u = index($0, "_")
        version = (u > 1) ? substr($0, 1, u - 1) : $0
        if (!(version in count)) order[++seen] = version
        files[version] = (files[version] == "") ? $0 : files[version] "\n      " $0
        count[version]++
      }
      END {
        for (i = 1; i <= seen; i++) {
          v = order[i]
          if (count[v] > 1) printf "  %s\n      %s\n", v, files[v]
        }
      }')

if [ -n "$collisions" ]; then
  echo "::error::Duplicate migration version stamp(s) between this PR and origin/$BASE."
  echo ""
  echo "These versions map to more than one file:"
  echo "$collisions"
  echo ""
  echo "Supabase keys schema_migrations by version, so applying both raises"
  echo "\"duplicate key value violates unique constraint schema_migrations_pkey\"."
  echo "Restamp YOUR file (never one already applied to production) to a version"
  echo "above the current head of $BASE, then force-push."
  echo "See .cursor/rules/migration-timestamps.mdc."
  exit 1
fi

echo "Migration stamp guard passed: no version collides between this PR and origin/$BASE."
