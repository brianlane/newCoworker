#!/usr/bin/env bash
# keep-warm.sh — Ping Ollama periodically so the owner's /dashboard/chat stays
# instant (Llama 3.2 / Qwen3 cold-load is 20-40s on KVM 2 and blocks the UI).
#
# Fires from ollama-keep-warm.timer every ~5 minutes. Stands down while the
# owner is actively chatting so we don't race the real /chat call or steal the
# single parallel slot on the starter tier.
#
# Skip heuristic: read `dashboard_chat_activity.last_user_chat_at` via the
# Supabase REST API. If the owner chatted within KEEP_WARM_SKIP_SECS, exit 0
# without pinging. Otherwise fire a single-token /api/generate with
# `keep_alive=-1` so the weights stay resident.
#
# Required env (from /opt/rowboat/.env):
#   BUSINESS_ID                this tenant's businesses.id
#   SUPABASE_URL               https://<project>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY  service-role JWT for REST read
#   OLLAMA_MODEL               e.g. llama3.2:3b (starter) / qwen3:4b-instruct
# Optional:
#   KEEP_WARM_SKIP_SECS        default 180

set -u

: "${BUSINESS_ID:?BUSINESS_ID is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
: "${OLLAMA_MODEL:?OLLAMA_MODEL is required}"

SKIP_SECS="${KEEP_WARM_SKIP_SECS:-180}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] keep-warm: $*"; }

# --- Activity check -----------------------------------------------------------
# dashboard_chat_activity is keyed by business_id (PK). Return the row or empty.
ACT_URL="${SUPABASE_URL%/}/rest/v1/dashboard_chat_activity?business_id=eq.${BUSINESS_ID}&select=last_user_chat_at&limit=1"

ACT_JSON="$(curl -sS --max-time 5 \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  "$ACT_URL" 2>/dev/null || echo '[]')"

# Pull last_user_chat_at without requiring jq; first ISO-8601 timestamp in the
# response is the field we want (the query selects only that column).
LAST_CHAT_ISO="$(echo "$ACT_JSON" \
  | grep -oE '"last_user_chat_at":"[^"]+"' \
  | head -n1 \
  | sed -E 's/.*"last_user_chat_at":"([^"]+)".*/\1/')"

if [[ -n "${LAST_CHAT_ISO:-}" ]]; then
  # BSD date on macOS won't parse ISO-8601 cleanly, but production runs on
  # Linux (Hostinger VPS / Ubuntu) where `date -d` handles it fine.
  if LAST_TS=$(date -d "$LAST_CHAT_ISO" +%s 2>/dev/null); then
    NOW_TS=$(date -u +%s)
    DELTA=$(( NOW_TS - LAST_TS ))
    if (( DELTA < SKIP_SECS )); then
      log "owner active ${DELTA}s ago (< ${SKIP_SECS}s), skipping ping"
      exit 0
    fi
  fi
fi

# --- Warm ping ---------------------------------------------------------------
# Single-token generate keeps the model pinned in RAM (OLLAMA_KEEP_ALIVE=-1 in
# the service override already says "never unload", but at least one load must
# have happened since the last restart). prompt + num_predict=1 is the cheapest
# path; response JSON is ignored.
PAYLOAD=$(cat <<JSON
{"model":"${OLLAMA_MODEL}","prompt":"ok","stream":false,"keep_alive":-1,"options":{"num_predict":1}}
JSON
)

if curl -sS --max-time 30 \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "${OLLAMA_URL%/}/api/generate" > /dev/null; then
  log "pinged ${OLLAMA_MODEL} (delta=${DELTA:-unknown}s)"
else
  log "WARN: ollama ping failed; heartbeat.sh will cover true outages"
  exit 0   # never let the timer go red on transient failures
fi
