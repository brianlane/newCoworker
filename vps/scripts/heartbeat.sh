#!/usr/bin/env bash
# heartbeat.sh — Monitor Rowboat + Ollama, auto-restart on failure
# Runs every 2 minutes via cron.

set -euo pipefail

FAIL_LOG="/var/log/heartbeat-failures.log"
MAX_FAILURES=3
FAILURE_COUNT_FILE="/tmp/.heartbeat_failures"

touch "$FAILURE_COUNT_FILE"
FAILURES=$(cat "$FAILURE_COUNT_FILE" 2>/dev/null || echo "0")

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] HEARTBEAT: $*"; }

check_rowboat() {
  curl -sf --max-time 5 http://127.0.0.1:3000/health > /dev/null 2>&1 \
    || curl -sf --max-time 5 http://127.0.0.1:3000/ > /dev/null 2>&1
}

check_ollama() {
  curl -sf --max-time 5 http://127.0.0.1:11434/api/tags > /dev/null 2>&1
}

ALL_OK=true

# Check Rowboat
if ! check_rowboat; then
  log "Rowboat unhealthy. Restarting..."
  docker compose -f /opt/rowboat/docker-compose.yml restart rowboat 2>&1 | tee -a "$FAIL_LOG"
  ALL_OK=false
fi

# Check Ollama
if ! check_ollama; then
  log "Ollama unhealthy. Restarting..."
  systemctl restart ollama || true
  ALL_OK=false
fi

if $ALL_OK; then
  echo "0" > "$FAILURE_COUNT_FILE"
  log "All services healthy."
else
  FAILURES=$(( FAILURES + 1 ))
  echo "$FAILURES" > "$FAILURE_COUNT_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Failure count: $FAILURES" >> "$FAIL_LOG"

  if (( FAILURES >= MAX_FAILURES )); then
    log "CRITICAL: $FAILURES consecutive failures. Escalating via notification webhook."
    WEBHOOK_URL="${SUPABASE_URL:-}/functions/v1/notifications"
    WEBHOOK_TOKEN="${NOTIFICATIONS_WEBHOOK_TOKEN:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
    if [[ -z "$WEBHOOK_TOKEN" ]]; then
      log "CRITICAL: Missing NOTIFICATIONS_WEBHOOK_TOKEN/SUPABASE_SERVICE_ROLE_KEY. Skipping escalation."
      echo "0" > "$FAILURE_COUNT_FILE"
      exit 0
    fi
    curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${WEBHOOK_TOKEN}" \
      -d "{\"type\":\"INSERT\",\"table\":\"coworker_logs\",\"record\":{\"id\":\"$(uuidgen)\",\"business_id\":\"${BUSINESS_ID:-unknown}\",\"task_type\":\"heartbeat\",\"status\":\"urgent_alert\",\"log_payload\":{\"failures\":${FAILURES}},\"created_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
      "$WEBHOOK_URL" > /dev/null 2>&1 || true
    echo "0" > "$FAILURE_COUNT_FILE"
  fi
fi
