#!/usr/bin/env bash
# The ONLY supported way to deploy Supabase edge functions.
#
# Why: every function in this project authenticates its own callers (cron
# bearer, Telnyx Ed25519 signature, webhook token — see supabase/config.toml),
# so the gateway JWT check must stay OFF. A plain `supabase functions deploy`
# has silently flipped `verify_jwt` back ON twice (newer CLI defaults),
# 401-ing every pg_cron tick and Telnyx webhook until someone noticed —
# stalled AiFlow runs, dropped inbound SMS, bounced voice webhooks.
#
# This wrapper always passes --no-verify-jwt and always deploys from the
# checkout it lives in, so the deployed code matches a known git ref.
#
# Usage:
#   scripts/deploy-edge-functions.sh <fn> [<fn> ...]   # named functions
#   scripts/deploy-edge-functions.sh --all             # every function in supabase/functions
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${REPO_ROOT}/supabase/config.toml"
PROJECT_REF="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$CONFIG")"

if [[ -z "$PROJECT_REF" ]]; then
  echo "error: could not read project_id from ${CONFIG}" >&2
  exit 2
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <function-name> [...] | --all" >&2
  exit 2
fi

FUNCTIONS=()
if [[ "$1" == "--all" ]]; then
  for dir in "${REPO_ROOT}"/supabase/functions/*/; do
    name="$(basename "$dir")"
    [[ "$name" == _* ]] && continue # shared modules, not deployable functions
    FUNCTIONS+=("$name")
  done
else
  FUNCTIONS=("$@")
fi

cd "$REPO_ROOT"
echo "deploying from $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) to project ${PROJECT_REF}"

FAILED=()
for fn in "${FUNCTIONS[@]}"; do
  if [[ ! -d "supabase/functions/${fn}" ]]; then
    echo "error: supabase/functions/${fn} does not exist" >&2
    FAILED+=("$fn")
    continue
  fi
  echo "── deploying ${fn} (verify_jwt=OFF)"
  if ! supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt; then
    FAILED+=("$fn")
  fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAILED: ${FAILED[*]}" >&2
  exit 1
fi
echo "all ${#FUNCTIONS[@]} function(s) deployed with the gateway JWT check off"
