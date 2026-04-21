#!/usr/bin/env bash
# flip-flags.sh — Idempotent toggler for the voice-bridge rollout env flags.
#
# The voice rollout has two kill switches, LIVE-IN on opposite sides:
#
#   * VOICE_AI_STREAM_ENABLED  (Edge / Supabase secret)
#       Controls whether telnyx-voice-inbound mints a signed stream URL.
#       FLIPPED VIA `supabase secrets set` — NOT by this script, because it's
#       a Supabase-side value, not a VPS-side one. This script PRINTS the
#       exact command to run. The helper lives here so ops have one place
#       to go for the whole toggle surface.
#
#   * GEMINI_LIVE_ENABLED      (VPS /opt/voice-bridge/.env)
#       Controls whether the voice-bridge actually pipes audio to Gemini
#       Live. When false, the media WebSocket still comes up (so Telnyx
#       sees a healthy WS) and the bridge just stays silent on the AI side.
#       FLIPPED BY THIS SCRIPT — edits the .env in place, restarts the
#       container (if running), logs before/after.
#
# Usage (run AS ROOT on the VPS):
#   sudo ./flip-flags.sh --gemini-live on
#   sudo ./flip-flags.sh --gemini-live off
#   sudo ./flip-flags.sh --print-edge-command VOICE_AI_STREAM_ENABLED=false
#   sudo ./flip-flags.sh --status
#
# Exits 0 on success, non-zero on any failure. Safe to re-run.

set -euo pipefail

ENV_FILE="${VOICE_BRIDGE_ENV_FILE:-/opt/voice-bridge/.env}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-voice-bridge}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/voice-bridge/docker-compose.yml}"

log() { echo "[flip-flags] $*"; }
fatal() { echo "[flip-flags] FATAL: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
flip-flags.sh — toggle voice rollout kill switches on the VPS

Commands:
  --gemini-live on|off           Edit $ENV_FILE and restart the bridge container
  --stream-enabled on|off        Print the exact `supabase secrets set` command
                                 (run it from your workstation; stream flag is
                                 server-side on Supabase Edge, not VPS-local).
  --status                       Print the current value of both flags
  --print-edge-command KV        Print supabase-cli snippet for an arbitrary KV

Env (optional):
  VOICE_BRIDGE_ENV_FILE          default: /opt/voice-bridge/.env
  COMPOSE_PROJECT                default: voice-bridge
  COMPOSE_FILE                   default: /opt/voice-bridge/docker-compose.yml
USAGE
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    fatal "must run as root (edit of ${ENV_FILE} requires it)"
  fi
}

to_bool() {
  case "${1:-}" in
    on|true|True|TRUE|1) echo "true" ;;
    off|false|False|FALSE|0) echo "false" ;;
    *) fatal "bad boolean: '$1' (use on/off)" ;;
  esac
}

# Read a KEY=VALUE from ENV_FILE; empty string if missing. Tolerant of comments
# and quoted values. Used both for --status and for the "did the value change?"
# check before we bother restarting.
read_env_value() {
  local key="$1"
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo ""
    return 0
  fi
  # shellcheck disable=SC2016
  awk -v K="${key}" -F'=' '
    $0 ~ /^[[:space:]]*#/ { next }
    $1 == K {
      v=$0; sub(/^[^=]*=/, "", v);
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v);
      gsub(/^"|"$/, "", v);
      gsub(/^'\''|'\''$/, "", v);
      print v; exit
    }
  ' "${ENV_FILE}"
}

# Write a single KEY=VALUE line into ENV_FILE, replacing any existing line for
# that key. File mode and ownership are preserved. `sed -i` is avoided because
# it leaves the file world-readable on some hosts.
write_env_value() {
  local key="$1" value="$2"
  if [[ ! -f "${ENV_FILE}" ]]; then
    install -m 0600 -o root -g root /dev/null "${ENV_FILE}"
  fi
  local tmp
  tmp="$(mktemp --tmpdir="$(dirname "${ENV_FILE}")" ".flip-flags.XXXXXX")"
  chmod 0600 "${tmp}"
  # Copy every non-matching line, then append the new one.
  awk -v K="${key}" -F'=' '$1 != K { print $0 }' "${ENV_FILE}" > "${tmp}"
  echo "${key}=${value}" >> "${tmp}"
  # Preserve ownership of the original file (fallback to root:root).
  local owner
  owner="$(stat -c '%U:%G' "${ENV_FILE}" 2>/dev/null || echo 'root:root')"
  chown "${owner}" "${tmp}"
  mv -f "${tmp}" "${ENV_FILE}"
}

restart_bridge() {
  if ! command -v docker >/dev/null 2>&1; then
    log "docker not installed — skipping restart"
    return 0
  fi
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    log "compose file ${COMPOSE_FILE} not found — skipping restart"
    return 0
  fi
  log "restarting voice-bridge container via docker compose…"
  docker compose -f "${COMPOSE_FILE}" -p "${COMPOSE_PROJECT}" up -d --force-recreate voice-bridge \
    || fatal "docker compose restart failed"
}

cmd_gemini_live() {
  local state="$1"
  require_root
  local normalized
  normalized="$(to_bool "${state}")"
  local prev
  prev="$(read_env_value GEMINI_LIVE_ENABLED)"
  log "GEMINI_LIVE_ENABLED: prev='${prev:-<unset>}' → new='${normalized}' (file=${ENV_FILE})"
  if [[ "${prev}" == "${normalized}" ]]; then
    log "no change required; skipping restart"
    return 0
  fi
  write_env_value GEMINI_LIVE_ENABLED "${normalized}"
  restart_bridge
  log "done"
}

cmd_status() {
  log "env file: ${ENV_FILE}"
  log "  GEMINI_LIVE_ENABLED = '$(read_env_value GEMINI_LIVE_ENABLED)'"
  log "  GOOGLE_API_KEY     = $([[ -n "$(read_env_value GOOGLE_API_KEY)" ]] && echo 'set' || echo 'unset')"
  log "  GEMINI_API_KEY     = $([[ -n "$(read_env_value GEMINI_API_KEY)" ]] && echo 'set' || echo 'unset')"
  log "  GEMINI_LIVE_MODEL  = '$(read_env_value GEMINI_LIVE_MODEL)'"
  log ""
  log "Edge side (not readable from the VPS): run"
  log "  supabase secrets list  # from your workstation"
  log "to see VOICE_AI_STREAM_ENABLED. Flip with --stream-enabled on|off."
}

cmd_print_edge_command() {
  local kv="$1"
  [[ "${kv}" == *=* ]] || fatal "expected KEY=VALUE (got '${kv}')"
  # shellcheck disable=SC2016
  cat <<CMD
# Run from your workstation (NOT the VPS). Requires supabase-cli login:
supabase secrets set --project-ref "\$SUPABASE_PROJECT_REF" '${kv}'

# Or via the REST API (PAT required):
curl -sSf -X PATCH \\
  -H "Authorization: Bearer \$SUPABASE_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  "https://api.supabase.com/v1/projects/\$SUPABASE_PROJECT_REF/secrets" \\
  -d "[{\\"name\\":\\"${kv%%=*}\\",\\"value\\":\\"${kv#*=}\\"}]"
CMD
}

cmd_stream_enabled() {
  local state="$1"
  local normalized
  normalized="$(to_bool "${state}")"
  cmd_print_edge_command "VOICE_AI_STREAM_ENABLED=${normalized}"
}

main() {
  if [[ $# -eq 0 ]]; then
    usage
    exit 2
  fi
  case "$1" in
    --gemini-live)
      [[ $# -ge 2 ]] || fatal "--gemini-live requires on|off"
      cmd_gemini_live "$2"
      ;;
    --stream-enabled)
      [[ $# -ge 2 ]] || fatal "--stream-enabled requires on|off"
      cmd_stream_enabled "$2"
      ;;
    --status)
      cmd_status
      ;;
    --print-edge-command)
      [[ $# -ge 2 ]] || fatal "--print-edge-command requires KEY=VALUE"
      cmd_print_edge_command "$2"
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
