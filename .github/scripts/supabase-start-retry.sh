#!/usr/bin/env bash
# supabase start pulls a stack of ghcr.io images. A 429 (toomanyrequests)
# fails the CLI after its own short retries. Worker Integration hit that
# twice on 2026-09-23 before any test ran. Retry with a longer pause, and
# stop leftovers so the next attempt starts clean.
set -u

attempts="${SUPABASE_START_ATTEMPTS:-4}"
pause="${SUPABASE_START_RETRY_SECONDS:-20}"
last=1
i=1
while [ "$i" -le "$attempts" ]; do
  supabase start "$@"
  last=$?
  if [ "$last" -eq 0 ]; then
    exit 0
  fi
  echo "supabase start failed (attempt ${i}/${attempts}, exit ${last})"
  supabase stop >/dev/null 2>&1 || true
  if [ "$i" -eq "$attempts" ]; then
    exit "$last"
  fi
  sleep "$pause"
  i=$((i + 1))
done
exit "$last"
