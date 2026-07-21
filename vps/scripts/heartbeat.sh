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

# KVM1 boxes ship no local model and no ollama.service at all — checking
# (and "restarting") Ollama there failed every 2-minute tick forever,
# spamming the log and tripping the failure counter for a service the box
# was never supposed to have.
ollama_unit_exists() {
  systemctl cat ollama.service > /dev/null 2>&1
}

ALL_OK=true

# Check Rowboat
if ! check_rowboat; then
  log "Rowboat unhealthy. Restarting..."
  docker compose -f /opt/rowboat/docker-compose.yml restart rowboat 2>&1 | tee -a "$FAIL_LOG"
  ALL_OK=false
fi

# Check Ollama (only on boxes that ship a local model)
if ollama_unit_exists && ! check_ollama; then
  log "Ollama unhealthy. Restarting..."
  systemctl restart ollama || true
  ALL_OK=false
fi

# ------------------------------------------------------------------
# Security-posture report (BYOS emphasis; harmless + useful on fleet boxes).
#
# Cron gives us no env, so source the chat-worker .env (root-only, written
# by deploy-client.sh) for BUSINESS_ID, ROWBOAT_GATEWAY_TOKEN, and the
# platform origin (WORKER_VERCEL_BASE_URL = APP_BASE_URL at deploy time).
# Throttled to ~1 report/hour via a timestamp file so the 2-minute cron
# doesn't flood the posture table. Every step is best-effort: posture
# reporting must never break the service-restart heartbeat above.
# ------------------------------------------------------------------
report_posture() {
  local env_file="/opt/chat-worker/.env"
  [[ -r "$env_file" ]] || return 0
  local BUSINESS_ID ROWBOAT_GATEWAY_TOKEN WORKER_VERCEL_BASE_URL
  BUSINESS_ID="$(grep -m1 '^BUSINESS_ID=' "$env_file" | cut -d= -f2-)"
  ROWBOAT_GATEWAY_TOKEN="$(grep -m1 '^ROWBOAT_GATEWAY_TOKEN=' "$env_file" | cut -d= -f2-)"
  WORKER_VERCEL_BASE_URL="$(grep -m1 '^WORKER_VERCEL_BASE_URL=' "$env_file" | cut -d= -f2-)"
  [[ -n "$BUSINESS_ID" && -n "$ROWBOAT_GATEWAY_TOKEN" && -n "$WORKER_VERCEL_BASE_URL" ]] || return 0

  local stamp="/tmp/.posture_last_report"
  local now epoch_last
  now="$(date +%s)"
  epoch_last="$(cat "$stamp" 2>/dev/null || echo 0)"
  (( now - epoch_last < 3600 )) && return 0

  local checks=()
  add_check() { # name ok detail
    checks+=("{\"name\":\"$1\",\"ok\":$2,\"detail\":\"$3\"}")
  }

  if ufw status 2>/dev/null | grep -q "Status: active"; then
    add_check ufw_active true "ufw active"
  else
    add_check ufw_active false "ufw inactive or missing"
  fi

  # `sshd -T` occasionally produces no output (transient — observed twice on
  # HQ while the effective config was verifiably correct), which the old
  # check misread as "allows password auth". Retry, and when the probe never
  # answers, say THAT instead of inventing a config finding.
  local sshd_effective="" sshd_try
  for sshd_try in 1 2 3; do
    sshd_effective="$(sshd -T 2>/dev/null | grep -i '^passwordauthentication' || true)"
    [[ -n "$sshd_effective" ]] && break
    sleep 2
  done
  if [[ -z "$sshd_effective" ]]; then
    add_check ssh_password_auth_disabled false "sshd -T probe failed (no output after 3 tries)"
  elif grep -qi "no" <<< "$sshd_effective"; then
    add_check ssh_password_auth_disabled true "password auth off"
  else
    add_check ssh_password_auth_disabled false "sshd allows password auth"
  fi

  if systemctl is-active fail2ban >/dev/null 2>&1; then
    add_check fail2ban_active true "fail2ban running"
  else
    add_check fail2ban_active false "fail2ban not running"
  fi

  if dpkg -s unattended-upgrades >/dev/null 2>&1; then
    add_check unattended_upgrades true "unattended-upgrades installed"
  else
    add_check unattended_upgrades false "unattended-upgrades missing"
  fi

  # Only SSH may listen publicly — everything else binds loopback / the
  # docker bridge behind the outbound tunnel. Whitelist:
  #   - ALL of 127.0.0.0/8 and [::1], not just 127.0.0.1 — systemd-resolved's
  #     DNS stub listens on 127.0.0.53/127.0.0.54:53 (with %iface suffixes),
  #     which is loopback and was false-positiving every fleet report.
  #   - Host Ollama on :11434 — bootstrap.sh deliberately binds it to
  #     0.0.0.0 so the dockerised llm-router can reach it via the docker
  #     bridge; UFW's INPUT default-deny (a host service, not a Docker
  #     published port) blocks it externally, verified 2026-07-20.
  local listeners
  listeners="$(ss -H -tlnp 2>/dev/null | awk '{print $4}' \
    | grep -Ev '^(127\.|\[?::1\]?[%:])' \
    | grep -Ev ':(22|11434)$' | sort -u | tr '\n' ' ' | sed 's/"/ /g')"
  if [[ -z "${listeners// /}" ]]; then
    add_check public_listeners true "only SSH listening publicly"
  else
    add_check public_listeners false "unexpected listeners: ${listeners}"
  fi

  # Ollama must be reachable THROUGH the docker bridge — the path the
  # dockerised llm-router actually uses (host.docker.internal → host
  # gateway). A loopback-only Ollama passes every host-side probe while the
  # local-model fallback 502s: exactly the July 2026 adopted-box drift
  # (config refreshed, service never restarted). Skipped on boxes that ship
  # no local model (no ollama unit, e.g. KVM1).
  if systemctl cat ollama.service > /dev/null 2>&1; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'llm-router'; then
      if docker exec llm-router sh -c \
          "wget -qO- -T 5 http://host.docker.internal:11434/api/tags > /dev/null 2>&1"; then
        add_check ollama_bridge_reachable true "llm-router reaches host ollama"
      else
        add_check ollama_bridge_reachable false \
          "llm-router cannot reach host ollama via the docker bridge (stale loopback bind? restart ollama)"
      fi
    else
      add_check ollama_bridge_reachable false "llm-router container not running"
    fi
  fi

  local joined payload
  joined="$(IFS=,; echo "${checks[*]}")"
  payload="{\"businessId\":\"${BUSINESS_ID}\",\"checks\":[${joined}]}"
  if curl -sf --max-time 15 -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${ROWBOAT_GATEWAY_TOKEN}" \
      -d "$payload" \
      "${WORKER_VERCEL_BASE_URL%/}/api/vps/posture" > /dev/null 2>&1; then
    echo "$now" > "$stamp"
    log "Posture report sent."
  else
    log "WARN: posture report POST failed (will retry next eligible run)."
  fi
}
report_posture || true

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
