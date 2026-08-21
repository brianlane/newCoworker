#!/usr/bin/env bash
# heartbeat.sh, Monitor Rowboat + Ollama, auto-restart on failure
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

# KVM1 boxes ship no local model and no ollama.service at all, checking
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
# Host CPU/memory sampler.
#
# Runs on EVERY 2-minute tick, unlike the posture report below which is
# throttled to one POST an hour. That split is the whole point: a single
# /proc/loadavg read taken once an hour covers under 2% of the wall clock and
# would miss every burst, so the box accumulates ~30 samples between reports
# and ships the summary. `load1Max` then means "the worst minute in this
# hour", not "the minute we happened to look".
#
# One line per sample, `load1 mem_avail_kb mem_total_kb swap_used_kb`. The
# posture report aggregates and TRUNCATES the file, so an unsent hour is
# never double counted and a box whose posture POST keeps failing cannot grow
# this file without bound (the truncate happens on aggregate, not on send).
#
# Best-effort throughout: an unreadable /proc must never break the
# service-restart heartbeat above, so every step is guarded and a failure
# just means one missing sample.
# ------------------------------------------------------------------
METRIC_SAMPLES_FILE="/tmp/.heartbeat_host_samples"

sample_host_metrics() {
  local load1 mem_avail_kb mem_total_kb swap_total_kb swap_free_kb swap_used_kb
  load1="$(awk '{print $1}' /proc/loadavg 2>/dev/null || true)"
  mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  swap_total_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_free_kb="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  [[ -n "$load1" && -n "$mem_avail_kb" && -n "$mem_total_kb" ]] || return 0
  (( mem_total_kb > 0 )) || return 0
  swap_used_kb=$(( swap_total_kb - swap_free_kb ))
  (( swap_used_kb < 0 )) && swap_used_kb=0
  # Cap the file so a box that never manages to POST cannot accumulate
  # forever: 2000 lines is ~66 hours of ticks, far past any real backlog.
  if [[ -f "$METRIC_SAMPLES_FILE" ]] && (( $(wc -l < "$METRIC_SAMPLES_FILE" 2>/dev/null || echo 0) >= 2000 )); then
    tail -n 1000 "$METRIC_SAMPLES_FILE" > "$METRIC_SAMPLES_FILE.tmp" 2>/dev/null \
      && mv "$METRIC_SAMPLES_FILE.tmp" "$METRIC_SAMPLES_FILE"
  fi
  printf '%s %s %s %s\n' "$load1" "$mem_avail_kb" "$mem_total_kb" "$swap_used_kb" \
    >> "$METRIC_SAMPLES_FILE" 2>/dev/null || true
}
sample_host_metrics || true

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

  # `sshd -T` occasionally produces no output (transient, observed twice on
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

  # Only SSH may listen publicly, everything else binds loopback / the
  # docker bridge behind the outbound tunnel. Whitelist:
  #   - ALL of 127.0.0.0/8 and [::1], not just 127.0.0.1, systemd-resolved's
  #     DNS stub listens on 127.0.0.53/127.0.0.54:53 (with %iface suffixes),
  #     which is loopback and was false-positiving every fleet report.
  #   - Host Ollama on :11434, bootstrap.sh deliberately binds it to
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

  # Memory headroom. On a CO-TENANTED box (the HQ KVM1 shares hardware with
  # the JobArms render sidecar, see src/lib/vps/shared-hardware.ts) two
  # Chromium services compete for 4GB, so running out of RAM is a real
  # failure mode and the voice bridge, being realtime, is the first thing to
  # suffer. Reporting headroom here means we see the cause before the symptom
  # gets blamed on Gemini Live. ZRAM is on for kvm1, so swap in use is the
  # honest early signal and rides along in the detail.
  #
  # Threshold is available-under-8% OR under 300 MiB, whichever is LARGER: a
  # small box should not be held to a percentage it can never meet, and a big
  # box should not be judged by an absolute floor it always clears. The
  # posture route ANDs every check into one ok, so this fires only on real
  # pressure, never as routine noise.
  local mem_total_kb mem_avail_kb swap_total_kb swap_free_kb
  mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_total_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_free_kb="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ -n "$mem_total_kb" ]] && (( mem_total_kb > 0 )); then
    local avail_mib avail_pct min_kb swap_note
    avail_mib=$(( mem_avail_kb / 1024 ))
    avail_pct=$(( mem_avail_kb * 100 / mem_total_kb ))
    min_kb=$(( mem_total_kb * 8 / 100 ))
    (( min_kb < 300 * 1024 )) && min_kb=$(( 300 * 1024 ))
    if (( swap_total_kb > 0 )); then
      swap_note=", swap $(( (swap_total_kb - swap_free_kb) / 1024 ))/$(( swap_total_kb / 1024 )) MiB used"
    else
      swap_note=", no swap"
    fi
    if (( mem_avail_kb >= min_kb )); then
      add_check memory_headroom true "${avail_mib} MiB available (${avail_pct}%)${swap_note}"
    else
      add_check memory_headroom false \
        "only ${avail_mib} MiB available (${avail_pct}%, floor $(( min_kb / 1024 )) MiB)${swap_note}"
    fi
  else
    add_check memory_headroom false "cannot read MemTotal from /proc/meminfo"
  fi

  # Ollama must be reachable THROUGH the docker bridge, the path the
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

  # Host metrics block, aggregated from the 2-minute samples accumulated
  # since the last report. Sent alongside the checks, NOT as a check: the
  # route ANDs every check into one `ok` and emits vps_posture_drift on a
  # failure, and a busy box is a capacity signal, not a security finding.
  # Omitted entirely when there are no samples, so the platform can tell
  # "nothing measured" from "measured and quiet".
  local metrics_json=""
  if [[ -s "$METRIC_SAMPLES_FILE" ]]; then
    metrics_json="$(awk -v cores="$(nproc 2>/dev/null || echo 1)" '
      NF >= 4 {
        n++
        if ($1 > loadmax) loadmax = $1
        loadsum += $1
        avail = $2 / 1024
        if (n == 1 || avail < availmin) availmin = avail
        total = $3 / 1024
        swap = $4 / 1024
        if (swap > swapmax) swapmax = swap
      }
      END {
        if (n == 0) exit 1
        if (cores < 1) cores = 1
        printf "{\"cpuCount\":%d,\"load1Max\":%.2f,\"load1Mean\":%.2f,\"memAvailableMinMib\":%d,\"memTotalMib\":%d,\"swapUsedMaxMib\":%d,\"samples\":%d}", \
          cores, loadmax, loadsum / n, availmin, total, swapmax, n
      }
    ' "$METRIC_SAMPLES_FILE" 2>/dev/null || true)"
    # Truncate on AGGREGATE, not on a successful POST. A box whose POST keeps
    # failing would otherwise re-send the same widening window every hour,
    # and each retry would look like a longer and longer period of load.
    : > "$METRIC_SAMPLES_FILE"
  fi

  # Live Ollama environment, for the platform's bootstrap-drift check.
  #
  # Read from the RUNNING PROCESS, not from override.conf. A box can carry a
  # perfectly correct drop-in and a service that was never restarted to pick
  # it up: that is the July 2026 adopted-box drift, where the refreshed
  # config never reached the live process and Ollama stayed loopback-bound
  # while every host-side probe passed. Comparing the file would have said
  # everything was fine.
  #
  # Omitted entirely on a box with no ollama unit (kvm1), and on any read
  # failure, so absence means "not measured" and never "matches".
  local ollama_env_json=""
  if systemctl cat ollama.service >/dev/null 2>&1; then
    local ollama_pid environ_raw
    ollama_pid="$(systemctl show -p MainPID --value ollama 2>/dev/null || true)"
    if [[ -n "$ollama_pid" && "$ollama_pid" != "0" ]]; then
      # Split the READ from the transform. If the environ is unreadable we
      # send nothing, and the platform records "not measured". If it IS
      # readable but carries no tuning at all, we must send an EMPTY object
      # rather than nothing: a completely untuned live process is the most
      # broken state there is, and reporting it as "not measured" would be
      # the same silence this whole check exists to break. So grep finding
      # no matches is swallowed, and the object is emitted either way.
      if environ_raw="$(tr '\0' '\n' < "/proc/$ollama_pid/environ" 2>/dev/null)"; then
        ollama_env_json="{$(printf '%s\n' "$environ_raw" \
          | grep -E '^(OLLAMA_|OMP_)[A-Z0-9_]+=' \
          | awk -F= '{ k=$1; sub(/^[^=]*=/, "", $0); v=$0;
                       gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v);
                       printf "%s\"%s\":\"%s\"", (n++ ? "," : ""), k, v }' || true)}"
      fi
    fi
  fi

  local joined payload extra=""
  [[ -n "$ollama_env_json" ]] && extra=",\"ollamaEnv\":${ollama_env_json}"
  joined="$(IFS=,; echo "${checks[*]}")"
  if [[ -n "$metrics_json" ]]; then
    payload="{\"businessId\":\"${BUSINESS_ID}\",\"checks\":[${joined}],\"metrics\":${metrics_json}${extra}}"
  else
    payload="{\"businessId\":\"${BUSINESS_ID}\",\"checks\":[${joined}]${extra}}"
  fi
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
