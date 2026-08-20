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
# integration job plus main-failure-watch.yml remain the backstop. For the
# ORDERING half of that window (stamp valid at review time, below the applied
# head by merge time: PR #1066 vs #1064 on 2026-07-31),
# .github/scripts/migration-order-heal.sh re-stamps the unapplied file at
# deploy time, so that case self-heals instead of blocking main. Duplicate
# stamps that reach main still fail the deploy loudly.
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
  echo "See supabase/migrations/CLAUDE.md."
  exit 1
fi

# Ordering: a PR-introduced migration that sorts at or below the migration
# head of the live $BASE tip is guaranteed to fail `supabase db push` once
# everything ahead of it applies, so fail it at review time too. Same
# residual window as the duplicate check (both-open PRs cannot see each
# other); .github/scripts/migration-order-heal.sh closes that at deploy time.
if [ -n "$base_files" ]; then
  base_head=$(printf '%s\n' "$base_files" | cut -d_ -f1 | sort | tail -1)
  stale=$(comm -23 \
    <(printf '%s\n' "$pr_files" | grep -v '^[[:space:]]*$' | sort -u) \
    <(printf '%s\n' "$base_files" | grep -v '^[[:space:]]*$' | sort -u) \
    | awk -v head="$base_head" '{
        u = index($0, "_")
        version = (u > 1) ? substr($0, 1, u - 1) : $0
        if (version <= head) print
      }')

  # PURE-RENAME exemption: a below-head file whose CONTENT is byte-identical
  # to a base file this PR REMOVES is a restore, not a new migration. The one
  # real occurrence: on 2026-08-19 the order heal, misled by a broken ledger
  # read, renamed the APPLIED 20260420100000_voice_telnyx_platform.sql to a
  # fresh stamp; putting the name back so it matches its ledger row again is
  # something this guard must not block, and could not otherwise express (the
  # below-head file it flags IS the correctly-stamped one). The exemption is
  # deliberately narrow: content must hash-match a removed base file exactly,
  # so no new SQL can ride it, the duplicate check above still applies, and a
  # rename whose lower stamp does not match an applied ledger row still fails
  # loudly at deploy time (db push, and the heal's age guard).
  if [ -n "$stale" ]; then
    removed_hashes=$(git ls-tree FETCH_HEAD -- "$MIGRATIONS_DIR/" \
      | awk '{ split($0, a, "\t"); n = a[2]; sub(".*/", "", n); print $3 "\t" n }' \
      | while IFS=$'\t' read -r hash name; do
          case "$name" in *.sql) ;; *) continue ;; esac
          # Herestring, not a pipe: grep -q exiting early would hand the
          # pipeline printf's EPIPE under pipefail, the same race the order
          # heal's membership read had (2026-08-19 incident).
          if ! grep -qxF "$name" <<< "$pr_files"; then
            printf '%s\n' "$hash"
          fi
        done)
    kept=""
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      blob=$(git hash-object "$MIGRATIONS_DIR/$f")
      if [ -n "$removed_hashes" ] && grep -qxF "$blob" <<< "$removed_hashes"; then
        echo "Note: $f sorts below the head of origin/$BASE but is a pure rename of a file this PR removes (content identical); allowed as a stamp restore. Deploy-time checks still verify it against the applied ledger."
      else
        kept="${kept}${f}"$'\n'
      fi
    done <<< "$stale"
    stale=$(printf '%s' "$kept" | grep -v '^$' || true)
  fi

  if [ -n "$stale" ]; then
    echo "::error::Migration(s) in this PR sort at or below the migration head of origin/$BASE ($base_head):"
    echo ""
    echo "$stale" | sed 's/^/  /'
    echo ""
    echo "Supabase applies migrations in filename order and refuses to insert one"
    echo "below the already-applied head, so this will fail the push-to-main deploy."
    echo "Rebase onto the current $BASE and re-stamp with scripts/new-migration.sh"
    echo "(move your SQL into the new file; the scaffold is empty)."
    exit 1
  fi
fi

echo "Migration stamp guard passed: no version collides between this PR and origin/$BASE."
