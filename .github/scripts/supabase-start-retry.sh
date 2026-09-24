#!/usr/bin/env bash
# supabase start pulls a stack of ghcr.io images. A 429 (toomanyrequests)
# fails the CLI after its own short retries. Worker Integration hit that
# twice on 2026-09-23 before any test ran.
#
# Retry ONLY that registry pull failure. A migration or health-check failure
# exits immediately. `supabase stop` keeps the Docker volume, and the next
# `supabase start` then exits 0 without applying migrations (CLI 2.78.1).
# A retry therefore wipes the volume first with `supabase stop --no-backup`.
set -u

attempts="${SUPABASE_START_ATTEMPTS:-4}"
pause="${SUPABASE_START_RETRY_SECONDS:-20}"
last=1
i=1

is_registry_pull_failure() {
  case "$1" in
    *toomanyrequests*|*failed\ to\ pull\ docker\ image*|*failed\ to\ display\ json\ stream*)
      return 0
      ;;
  esac
  return 1
}

while [ "$i" -le "$attempts" ]; do
  output=$(supabase start "$@" 2>&1)
  last=$?
  printf '%s\n' "$output"
  if [ "$last" -eq 0 ]; then
    exit 0
  fi
  echo "supabase start failed (attempt ${i}/${attempts}, exit ${last})"
  if ! is_registry_pull_failure "$output"; then
    exit "$last"
  fi
  if [ "$i" -eq "$attempts" ]; then
    exit "$last"
  fi
  supabase stop --no-backup >/dev/null 2>&1 || true
  sleep "$pause"
  i=$((i + 1))
done
exit "$last"
