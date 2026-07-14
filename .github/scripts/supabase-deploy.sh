#!/usr/bin/env bash
# supabase-deploy.sh — keep production Supabase in lockstep with the repo.
#
#   check   drift check only (PRs): `supabase db push --dry-run` fails loudly
#           when the REMOTE migration ledger has versions that don't exist in
#           supabase/migrations/ — the drift class that previously had to be
#           found and repaired by hand (renamed/deleted migration files). It
#           also prints which pending local migrations WOULD be applied, so a
#           reviewer sees the exact DDL a merge will run.
#   deploy  (push to main): apply pending migrations with `supabase db push`
#           (same built-in drift guard — drift blocks the deploy rather than
#           being papered over), then bulk-deploy EVERY edge function so no
#           deployed bundle can go stale relative to the repo. Function
#           verify_jwt flags come from supabase/config.toml (tracked), so a
#           bulk deploy can never flip a function's JWT gate.
#
# Drift is never auto-repaired here: `supabase migration repair` rewrites the
# production ledger and must stay a deliberate human/agent action.
#
# Expected env: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD.
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

# Non-interactive: SUPABASE_DB_PASSWORD is picked up from the environment.
supabase link --project-ref "$PROJECT_REF"

case "$MODE" in
  check)
    supabase db push --dry-run
    echo "Drift check passed: every remote ledger entry exists in supabase/migrations/."
    ;;
  deploy)
    supabase db push
    echo "Migrations applied (or already up to date). Deploying all edge functions..."
    supabase functions deploy
    echo "All edge functions deployed from this commit."
    ;;
  *)
    echo "::error::unknown mode '$MODE' (expected check|deploy)"
    exit 1
    ;;
esac
