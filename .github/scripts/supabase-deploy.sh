#!/usr/bin/env bash
# supabase-deploy.sh: keep production Supabase in lockstep with the repo.
#
#   check   drift check only (PRs): `supabase db push --dry-run` fails loudly
#           when the REMOTE migration ledger has versions that don't exist in
#           supabase/migrations/, the drift class that previously had to be
#           found and repaired by hand (renamed/deleted migration files). It
#           also prints which pending local migrations WOULD be applied, so a
#           reviewer sees the exact DDL a merge will run.
#   deploy  (push to main): apply pending migrations with `supabase db push`
#           (same built-in drift guard: drift blocks the deploy rather than
#           being papered over), then bulk-deploy EVERY edge function so no
#           deployed bundle can go stale relative to the repo. Function
#           verify_jwt flags come from supabase/config.toml (tracked), so a
#           bulk deploy can never flip a function's JWT gate.
#
# Drift is never auto-repaired here: `supabase migration repair` rewrites the
# production ledger and must stay a deliberate human/agent action.
#
# Every DDL connection is pinned to the IPv4 SESSION POOLER, never the direct
# database host. `db.<ref>.supabase.co` publishes ONLY an AAAA record and
# GitHub's hosted runners have no IPv6 route, so any CLI code path that
# reaches for the direct connection dies with "dial tcp [2600:...]:5432:
# connect: network is unreachable" (run 31068979036, 2026-08-06: the deploy
# failed, the retry failed on an unrelated Supabase 502, and the watcher
# emailed that production had not updated). Port 5432 is the SESSION pooler
# and is required: the transaction pooler on 6543 cannot run migrations.
#
# Expected env: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD. SUPABASE_REGION
# overrides the pooler region, which is otherwise a fixed property of the
# project (verified against the live pooler: us-east-1 answers "tenant/user
# not found" for this ref, us-east-2 serves it).
set -euo pipefail

MODE="${1:?usage: supabase-deploy.sh check|deploy}"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  echo "::error::SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD secrets are not available to this run."
  exit 1
fi

PROJECT_REF=$(sed -n 's/^project_id = "\(.*\)"/\1/p' supabase/config.toml)
if [ -z "$PROJECT_REF" ]; then
  echo "::error::could not read project_id from supabase/config.toml"
  exit 1
fi

# The CLI documents --db-url as "must be percent-encoded", so the password is
# encoded rather than interpolated raw: a rotation that introduces an @ or a /
# would otherwise silently produce a malformed URL. Mask the encoded form too,
# since Actions only masks the secret's literal value and an encoded password
# would sail through the scrubber into any error text.
DB_PASSWORD_ENCODED=$(jq -rn --arg s "$SUPABASE_DB_PASSWORD" '$s|@uri')
# Only inside Actions, where the runner CONSUMES this line. Anywhere else it
# is just an echo that would print the password to the local terminal.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::$DB_PASSWORD_ENCODED"
fi

SUPABASE_REGION="${SUPABASE_REGION:-us-east-2}"
# Exported so migration-order-heal.sh reads the ledger over the same pooler.
# Percent-encoding guarantees the URL contains no whitespace, which is what
# makes the unquoted ${SUPABASE_DB_URL:+...} expansion there safe.
export SUPABASE_DB_URL="postgresql://postgres.${PROJECT_REF}:${DB_PASSWORD_ENCODED}@aws-1-${SUPABASE_REGION}.pooler.supabase.com:5432/postgres?sslmode=require"

# Still needed for `functions deploy`, which talks to the management API
# rather than Postgres and so has no --db-url of its own.
# Non-interactive: SUPABASE_DB_PASSWORD is picked up from the environment.
supabase link --project-ref "$PROJECT_REF"

case "$MODE" in
  check)
    supabase db push --dry-run --db-url "$SUPABASE_DB_URL"
    echo "Drift check passed: every remote ledger entry exists in supabase/migrations/."
    ;;
  deploy)
    # Heal the post-approval merge window first: a migration whose stamp was
    # valid at review time can sort below the applied head by merge time when
    # another PR's migration merged first (PR #1066 vs #1064, 2026-07-31).
    # The heal re-stamps only files ABSENT from the remote ledger, commits
    # the rename to main, and lets this same run continue; applied files and
    # the ledger itself are never touched, so "drift is never auto-repaired
    # here" still holds.
    bash "$(dirname "${BASH_SOURCE[0]}")/migration-order-heal.sh"
    supabase db push --db-url "$SUPABASE_DB_URL"
    echo "Migrations applied (or already up to date). Deploying all edge functions..."
    supabase functions deploy
    echo "All edge functions deployed from this commit."
    ;;
  *)
    echo "::error::unknown mode '$MODE' (expected check|deploy)"
    exit 1
    ;;
esac
