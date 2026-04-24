#!/usr/bin/env bash
# deploy-client.sh — Provision a client-specific configuration on the VPS
# Called from the orchestration API after bootstrap.sh has run.
#
# Environment variables expected:
#   BUSINESS_ID              — UUID from Supabase
#   TIER                     — starter | standard
#   SUPABASE_URL             — Supabase project URL
#   SUPABASE_SERVICE_KEY     — Service role key (write config back)
#   CLOUDFLARE_TUNNEL_TOKEN  — cloudflared tunnel token
#   ROWBOAT_GATEWAY_TOKEN    — shared bearer token for Rowboat gateway auth
#   NOTIFICATIONS_WEBHOOK_TOKEN — token for Supabase Edge Function auth
#   TELNYX_API_KEY           — Telnyx API key (Messaging + Call Control)
#   TELNYX_MESSAGING_PROFILE_ID — Telnyx messaging profile for SMS
#   TELNYX_SMS_FROM_E164     — optional E.164 from-number
#   STREAM_URL_SIGNING_SECRET — HMAC secret for media stream URLs (Edge + bridge)
#   BRIDGE_MEDIA_WSS_ORIGIN  — public wss:// origin for the VPS voice bridge
#   GOOGLE_API_KEY           — Gemini API key; blank disables Live on the bridge
#   GEMINI_LIVE_MODEL        — optional; default gemini-3.1-flash-live-preview
#   GEMINI_ROWBOAT_MODEL     — optional; Gemini model used by Rowboat's voice_task
#                               agent via the llm-router sidecar. Defaults to
#                               gemini-3.1-flash.
#   LLM_ROUTER_PORT          — optional; loopback port for the llm-router
#                               sidecar (default 11435).
#   GEMINI_LIVE_ENABLED      — optional secondary rollout kill switch for the
#                               bridge ("false" keeps media WS up but silences
#                               AI audio). When unset the deploy preserves any
#                               value already present in the VPS's existing
#                               /opt/voice-bridge/.env, defaulting to "true".
#                               This matches the bridge's own default in
#                               vps/voice-bridge/src/index.ts.
#   VOICE_TRANSCRIPTION_ENABLED — optional rollout flag for Gemini Live
#                               transcript capture. "true" attaches the
#                               Supabase transcript adapter in the bridge and
#                               persists voice_call_transcript_turns rows.
#                               Same preserve-existing-value pattern as
#                               GEMINI_LIVE_ENABLED: when unset the deploy
#                               keeps whatever is in /opt/voice-bridge/.env,
#                               defaulting to "false" (off for staged rollout).
#   VOICE_BRIDGE_SRC         — optional; path on VPS to copy bridge source from
#                               (default: /opt/newcoworker-repo/vps/voice-bridge).
#                               Operator is responsible for syncing the repo to
#                               this path (e.g. via git clone in bootstrap.sh or
#                               a rsync from the orchestrator).
#   LIGHTPANDA_WSS_URL       — Lightpanda browser endpoint
#   PROVISIONING_PROGRESS_URL — optional; POST JSON progress to app (see report_progress)
#   PROVISIONING_PROGRESS_TOKEN — Bearer token for progress API

set -euo pipefail

TIER="${TIER:-standard}"
LOG="/var/log/deploy-client-${BUSINESS_ID:-unknown}.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

report_progress() {
  local pct="$1" phase="$2" msg="$3"
  if [[ -z "${PROVISIONING_PROGRESS_URL:-}" || -z "${PROVISIONING_PROGRESS_TOKEN:-}" ]]; then
    return 0
  fi
  local json
  json=$(jq -nc \
    --arg id "${BUSINESS_ID}" \
    --argjson pct "$pct" \
    --arg ph "$phase" \
    --arg msg "$msg" \
    '{businessId:$id, percent:$pct, phase:$ph, message:$msg}')
  curl -sf -X POST "${PROVISIONING_PROGRESS_URL}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${PROVISIONING_PROGRESS_TOKEN}" \
    -d "$json" || true
}

log "=== Deploying client: ${BUSINESS_ID} (TIER=${TIER}) ==="

# ------------------------------------------------------------------
# 1. Fetch business config from Supabase and write Rowboat vault
# ------------------------------------------------------------------
log "Fetching business config from Supabase..."
CONFIG_JSON=$(curl -sf \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  "${SUPABASE_URL}/rest/v1/business_configs?business_id=eq.${BUSINESS_ID}&select=soul_md,identity_md,memory_md,website_md" \
  | jq -r '.[0]')

SOUL_MD=$(echo "$CONFIG_JSON" | jq -r '.soul_md // empty')
IDENTITY_MD=$(echo "$CONFIG_JSON" | jq -r '.identity_md // empty')
MEMORY_MD=$(echo "$CONFIG_JSON" | jq -r '.memory_md // empty')
# website_md is optional; absent on older deployments without the
# 20260426000000_add_business_website migration applied yet.
WEBSITE_MD=$(echo "$CONFIG_JSON" | jq -r '.website_md // empty')

slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

mkdir -p /opt/rowboat/vault /opt/rowboat/memory

echo "$SOUL_MD"     > /opt/rowboat/vault/soul.md
echo "$IDENTITY_MD" > /opt/rowboat/vault/identity.md
echo "$MEMORY_MD"   > /opt/rowboat/vault/memory.md
# website.md is written even when empty so the voice-bridge vault loader has
# a stable file to stat; an empty file simply omits the website section from
# Gemini Live's system instruction.
echo "$WEBSITE_MD"  > /opt/rowboat/vault/website.md

mkdir -p /opt/rowboat/memory/Organizations /opt/rowboat/memory/People /opt/rowboat/memory/Topics /opt/rowboat/memory/Projects
mkdir -p /opt/rowboat/memory/.newcoworker-seeds

BUSINESS_NAME=$(echo "$IDENTITY_MD" | awk -F': ' '/^Business Name:/ {print $2; exit}')
OWNER_NAME=$(echo "$IDENTITY_MD" | awk -F': ' '/^Owner \/ Primary Contact:/ {print $2; exit}')

BUSINESS_SLUG=$(slugify "${BUSINESS_NAME:-business}")
OWNER_SLUG=$(slugify "${OWNER_NAME:-primary-contact}")
SEED_MANIFEST="/opt/rowboat/memory/.newcoworker-seeds/${BUSINESS_ID}.list"

if [[ -f "$SEED_MANIFEST" ]]; then
  while IFS= read -r seeded_path; do
    [[ -n "$seeded_path" ]] || continue
    rm -f "$seeded_path"
  done < "$SEED_MANIFEST"
fi

ORGANIZATION_NOTE="/opt/rowboat/memory/Organizations/${BUSINESS_SLUG}.md"
OWNER_NOTE="/opt/rowboat/memory/People/${OWNER_SLUG}.md"
RULES_NOTE="/opt/rowboat/memory/Topics/assistant-operating-rules.md"
PLAYBOOK_NOTE="/opt/rowboat/memory/Topics/conversation-playbook.md"
BOOTSTRAP_NOTE="/opt/rowboat/memory/Projects/onboarding-bootstrap.md"

cat > "$ORGANIZATION_NOTE" <<EOF
# ${BUSINESS_NAME:-Business}

Seeded during New Coworker onboarding.

## Identity
$(printf '%s\n' "$IDENTITY_MD")
EOF

cat > "$OWNER_NOTE" <<EOF
# ${OWNER_NAME:-Primary Contact}

## Relationship
- Primary contact for ${BUSINESS_NAME:-the business}

## Notes
- Seeded during New Coworker onboarding.
EOF

cat > "$RULES_NOTE" <<EOF
# Assistant Operating Rules

$(printf '%s\n' "$SOUL_MD")
EOF

cat > "$PLAYBOOK_NOTE" <<EOF
# Conversation Playbook

$(printf '%s\n' "$MEMORY_MD")
EOF

cat > "$BOOTSTRAP_NOTE" <<EOF
# Onboarding Bootstrap

- Business: ${BUSINESS_NAME:-Business}
- Seeded At: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
- Source: New Coworker onboarding chat
- Vault Files: soul.md, identity.md, memory.md
EOF

cat > "$SEED_MANIFEST" <<EOF
$ORGANIZATION_NOTE
$OWNER_NOTE
$RULES_NOTE
$PLAYBOOK_NOTE
$BOOTSTRAP_NOTE
EOF

report_progress 42 "vault_seeded" "Vault and memory seeds written"

# ------------------------------------------------------------------
# 2. Write Rowboat .env with client-specific values
# ------------------------------------------------------------------
log "Writing Rowboat .env..."

# Tier-aware model selection
# Starter (KVM2): **`llama3.2:3b`**. Standard (KVM8 CPU): **`qwen3:4b-instruct`**. Dual fast/balanced tags are for GPU hosts only.
if [[ "${TIER}" == "starter" ]]; then
  OLLAMA_MODEL="llama3.2:3b"
else
  OLLAMA_MODEL="qwen3:4b-instruct"
fi
# Optional: cap num_ctx for starter TTFT — see vps/fragments/ollama-Modelfile-starter-4096.example

# llm-router sidecar: Rowboat talks to a small proxy (compose service
# `llm-router`) that forwards llama*/qwen* traffic to Ollama and gemini-*
# traffic to Gemini's OpenAI-compatible endpoint. This lets a single Rowboat
# container serve both the SMS dispatcher agent (Ollama) and the voice_task
# agent (Gemini).
LLM_ROUTER_PORT="${LLM_ROUTER_PORT:-11435}"
GEMINI_ROWBOAT_MODEL_DEFAULT="gemini-3.1-flash"

cat > /opt/rowboat/.env <<RENV_EOF
# Rowboat runtime configuration for business: ${BUSINESS_ID}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN}
BUSINESS_ID=${BUSINESS_ID}
TIER=${TIER}

# LLM provider routing — Rowboat talks to the llm-router sidecar (same
# docker-compose network) which forwards to Ollama for dispatcher (SMS)
# and Gemini for voice_task (voice). The llm-router service uses its
# compose DNS alias; no host.docker.internal hop needed from Rowboat.
PROVIDER_BASE_URL=http://llm-router:${LLM_ROUTER_PORT}/v1
PROVIDER_API_KEY=router
PROVIDER_DEFAULT_MODEL=${OLLAMA_MODEL}
PROVIDER_COPILOT_MODEL=${OLLAMA_MODEL}

# Gemini model used by the voice_task agent via the llm-router.
GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
GEMINI_ROWBOAT_MODEL=${GEMINI_ROWBOAT_MODEL:-${GEMINI_ROWBOAT_MODEL_DEFAULT}}
OLLAMA_MODEL=${OLLAMA_MODEL}

# Where Rowboat should POST voice-tool calls from the voice_task agent.
# Routed through the platform Next.js app which proxies to Nango / Telnyx /
# CRM loggers. ROWBOAT_GATEWAY_TOKEN authenticates these calls.
APP_BASE_URL=${APP_BASE_URL:-}

# Telnyx (SMS + voice Call Control is on platform Edge; bridge uses stream signing secret)
TELNYX_API_KEY=${TELNYX_API_KEY:-}
TELNYX_MESSAGING_PROFILE_ID=${TELNYX_MESSAGING_PROFILE_ID:-}
TELNYX_SMS_FROM_E164=${TELNYX_SMS_FROM_E164:-}
STREAM_URL_SIGNING_SECRET=${STREAM_URL_SIGNING_SECRET:-}
BRIDGE_MEDIA_WSS_ORIGIN=${BRIDGE_MEDIA_WSS_ORIGIN:-}

# Supabase notifications
NOTIFICATION_WEBHOOK=${SUPABASE_URL}/functions/v1/notifications
NOTIFICATION_WEBHOOK_TOKEN=${NOTIFICATIONS_WEBHOOK_TOKEN:-${SUPABASE_SERVICE_KEY}}

# Browser skills
LIGHTPANDA_WSS_URL=${LIGHTPANDA_WSS_URL:-wss://cdn.lightpanda.io/ws}

# Paths inside the Rowboat container (see bootstrap docker-compose volume mounts)
ROWBOAT_VAULT_PATH=/vault
ROWBOAT_MEMORY_PATH=/memory
RENV_EOF

# Lock down the env file: it carries ROWBOAT_GATEWAY_TOKEN,
# NOTIFICATION_WEBHOOK_TOKEN (Supabase service-role by default),
# STREAM_URL_SIGNING_SECRET, TELNYX_API_KEY, and GOOGLE_API_KEY. Root-only
# read matches the posture of /opt/rowboat/keep-warm.env and the
# voice-bridge .env written later in this script.
chmod 600 /opt/rowboat/.env

log "Rowboat .env written."

report_progress 55 "env_written" "Rowboat .env written"

# ------------------------------------------------------------------
# 2b. Install ollama-keep-warm timer
#
# /dashboard/chat's first message cold-starts Ollama (20-40s on KVM 2),
# which is the single biggest source of "the chat is slow" reports. We
# pair `OLLAMA_KEEP_ALIVE=-1` (set in bootstrap's service override) with
# a scheduled single-token generate that stands down while the owner is
# actively chatting — implementation in vps/scripts/keep-warm.sh.
# ------------------------------------------------------------------
log "Installing ollama-keep-warm.timer..."

# Script lives alongside the staged repo so rsync from bootstrap picks it
# up; we copy into /opt/rowboat so the systemd unit has a stable path.
KEEPWARM_SRC="${NEWCOWORKER_REPO_PATH:-/opt/newcoworker-repo}/vps/scripts/keep-warm.sh"
if [[ -f "${KEEPWARM_SRC}" ]]; then
  install -m 0755 "${KEEPWARM_SRC}" /opt/rowboat/keep-warm.sh
else
  log "WARN: ${KEEPWARM_SRC} missing; keep-warm will not be installed on this deploy"
fi

# Dedicated env file — avoids exposing unrelated Rowboat secrets to a
# systemd-invoked script that only needs the 4 keys below.
cat > /opt/rowboat/keep-warm.env <<KWENV
BUSINESS_ID=${BUSINESS_ID}
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_KEY}
OLLAMA_MODEL=${OLLAMA_MODEL}
KWENV
chmod 600 /opt/rowboat/keep-warm.env

if [[ -f /opt/rowboat/keep-warm.sh ]]; then
  cat > /etc/systemd/system/ollama-keep-warm.service <<'SERVICE'
[Unit]
Description=Keep Ollama warm for /dashboard/chat
After=network-online.target ollama.service
Wants=ollama.service

[Service]
Type=oneshot
EnvironmentFile=/opt/rowboat/keep-warm.env
ExecStart=/opt/rowboat/keep-warm.sh
# Exit codes other than 0 are already swallowed inside the script so a
# transient ollama restart doesn't flag the unit red.
SuccessExitStatus=0
SERVICE

  cat > /etc/systemd/system/ollama-keep-warm.timer <<'TIMER'
[Unit]
Description=Run ollama-keep-warm every 5 minutes after boot
Requires=ollama-keep-warm.service

[Timer]
# Start soon after boot once Ollama has finished loading, then fire every 5m.
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=ollama-keep-warm.service

[Install]
WantedBy=timers.target
TIMER

  systemctl daemon-reload
  systemctl enable --now ollama-keep-warm.timer
  log "ollama-keep-warm.timer enabled"
else
  log "WARN: skipping ollama-keep-warm.timer install (script missing)"
fi

# ------------------------------------------------------------------
# 3. Apply Rowboat stack (recreate if compose changed; drop orphan ollama from older layouts)
# ------------------------------------------------------------------
docker compose -f /opt/rowboat/docker-compose.yml up -d --remove-orphans || true
log "Rowboat stack updated."

# Bands align with integration ordering: stack up → HTTP readiness → tunnel → Supabase patch (see vps/integration/README.md).
report_progress 68 "rowboat_stack" "Docker Compose stack updated"

if curl -sf --max-time 15 http://127.0.0.1:3000/health >/dev/null 2>&1 || curl -sf --max-time 15 http://127.0.0.1:3000/ >/dev/null 2>&1; then
  report_progress 78 "rowboat_http" "Rowboat HTTP endpoint reachable"
else
  log "WARN: Rowboat /health HTTP check failed (containers may still be warming)"
fi

# ------------------------------------------------------------------
# 4. Set up cloudflared tunnel
# ------------------------------------------------------------------
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  log "Configuring cloudflared tunnel..."
  cloudflared service install "${CLOUDFLARE_TUNNEL_TOKEN}"
  systemctl enable cloudflared
  systemctl start cloudflared
  log "cloudflared tunnel active."
else
  log "WARN: No CLOUDFLARE_TUNNEL_TOKEN provided. Tunnel not configured."
fi

report_progress 85 "cloudflared" "Tunnel step finished (configured or skipped)"

# ------------------------------------------------------------------
# 5. Register VPS as online in Supabase
# ------------------------------------------------------------------
log "Updating business status in Supabase..."
curl -sf -X PATCH \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"status": "online"}' \
  "${SUPABASE_URL}/rest/v1/businesses?id=eq.${BUSINESS_ID}" \
  > /dev/null

report_progress 95 "business_online_patch" "Business status set to online in Supabase"

# ------------------------------------------------------------------
# 6. Voice bridge: sync source into /opt/voice-bridge and (re)start the container.
#
# Rollout rules:
#   * Sync the bridge source from ${VOICE_BRIDGE_SRC} (default
#     /opt/newcoworker-repo/vps/voice-bridge) so `docker compose build` picks
#     up repo updates since the last deploy. If no source exists, we skip the
#     bridge entirely — preserves the "optional sidecar" behavior for VPS
#     hosts that have not yet been staged.
#   * ALWAYS rewrite .env. The previous "if [[ ! -f .env ]]" guard meant
#     STREAM_URL_SIGNING_SECRET / GOOGLE_API_KEY rotations would not reach
#     the container on the next deploy.
#   * Use --force-recreate so a changed .env actually restarts the service
#     even when the image layer is cached.
#   * Health-gate up to ~40s on http://127.0.0.1:8090/ — a failed bridge
#     brings this whole phase down loudly instead of silently skipping.
# ------------------------------------------------------------------
VOICE_BRIDGE_SRC="${VOICE_BRIDGE_SRC:-/opt/newcoworker-repo/vps/voice-bridge}"
VOICE_BRIDGE_DEST="/opt/voice-bridge"
NEWCOWORKER_REPO_URL="${NEWCOWORKER_REPO_URL:-https://github.com/brianlane/newCoworker.git}"
NEWCOWORKER_REPO_REF="${NEWCOWORKER_REPO_REF:-main}"
NEWCOWORKER_REPO_PATH="${NEWCOWORKER_REPO_PATH:-/opt/newcoworker-repo}"

# Keep the staged repo in lockstep with `${NEWCOWORKER_REPO_REF}` on every
# deploy so the voice-bridge rsync below always picks up the latest source.
# bootstrap.sh does the initial clone; this block handles the ongoing pull
# and tolerates the "staging skipped / overridden" case silently. If the
# operator has pointed VOICE_BRIDGE_SRC at a custom path that isn't a git
# checkout, we leave it alone — their sync discipline, their source of truth.
if [[ "${VOICE_BRIDGE_SRC}" == "${NEWCOWORKER_REPO_PATH}/vps/voice-bridge" ]]; then
  if [[ -d "${NEWCOWORKER_REPO_PATH}/.git" ]]; then
    log "Refreshing repo at ${NEWCOWORKER_REPO_PATH} (ref=${NEWCOWORKER_REPO_REF})..."
    git -C "${NEWCOWORKER_REPO_PATH}" fetch --depth=1 origin "${NEWCOWORKER_REPO_REF}" || \
      log "WARN: git fetch failed; continuing with existing tree at ${NEWCOWORKER_REPO_PATH}"
    git -C "${NEWCOWORKER_REPO_PATH}" checkout -B "${NEWCOWORKER_REPO_REF}" \
        "origin/${NEWCOWORKER_REPO_REF}" || true
  elif command -v git >/dev/null 2>&1; then
    log "Repo missing at ${NEWCOWORKER_REPO_PATH}; cloning..."
    mkdir -p "$(dirname "${NEWCOWORKER_REPO_PATH}")"
    git clone --depth=1 --branch "${NEWCOWORKER_REPO_REF}" \
      "${NEWCOWORKER_REPO_URL}" "${NEWCOWORKER_REPO_PATH}" || \
      log "WARN: git clone failed; voice-bridge sync will be skipped"
  fi
fi

if [[ -d "${VOICE_BRIDGE_SRC}" && -f "${VOICE_BRIDGE_SRC}/docker-compose.yml" ]]; then
  log "Syncing voice-bridge source ${VOICE_BRIDGE_SRC} → ${VOICE_BRIDGE_DEST}..."
  mkdir -p "${VOICE_BRIDGE_DEST}"
  # --delete keeps the staging directory in lockstep with the repo; exclude
  # runtime-only artifacts so `.env` and node_modules rebuilds survive.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude ".env" \
      --exclude "node_modules" \
      --exclude "dist" \
      "${VOICE_BRIDGE_SRC}/" "${VOICE_BRIDGE_DEST}/"
  else
    log "rsync not installed; falling back to cp -R (no --delete)"
    cp -R "${VOICE_BRIDGE_SRC}/." "${VOICE_BRIDGE_DEST}/"
  fi
fi

if [[ -f "${VOICE_BRIDGE_DEST}/docker-compose.yml" ]]; then
  log "Starting voice-bridge from ${VOICE_BRIDGE_DEST}..."
  (
    cd "${VOICE_BRIDGE_DEST}"

    # GEMINI_LIVE_ENABLED is the bridge's secondary fine-grained kill switch
    # (primary being an empty GOOGLE_API_KEY). Because we now always rewrite
    # .env on every deploy — necessary so secret rotations like
    # STREAM_URL_SIGNING_SECRET reach the container — we have to explicitly
    # preserve this flag or an operator who SSH'd in and set it to "false"
    # would have Gemini Live silently re-enabled on the next deploy.
    #
    # Precedence:
    #   1. Orchestrator-provided GEMINI_LIVE_ENABLED (centralized control)
    #   2. Existing value in /opt/voice-bridge/.env (per-VPS override)
    #   3. "true" (matches the bridge's in-code default)
    prev_gemini_live_enabled=""
    if [[ -f "${VOICE_BRIDGE_DEST}/.env" ]]; then
      prev_gemini_live_enabled=$(
        grep -E '^GEMINI_LIVE_ENABLED=' "${VOICE_BRIDGE_DEST}/.env" 2>/dev/null \
          | tail -n 1 \
          | cut -d= -f2- \
          | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
      ) || true
    fi
    effective_gemini_live_enabled="${GEMINI_LIVE_ENABLED:-${prev_gemini_live_enabled:-true}}"

    # Same precedence ladder as GEMINI_LIVE_ENABLED above — operator can flip
    # transcription on for a single VPS without losing the flag on redeploy.
    # Default stays "false" so the feature only turns on where explicitly opted
    # in (either via Vercel → orchestrator, or by hand-editing the VPS .env).
    prev_voice_transcription_enabled=""
    if [[ -f "${VOICE_BRIDGE_DEST}/.env" ]]; then
      prev_voice_transcription_enabled=$(
        grep -E '^VOICE_TRANSCRIPTION_ENABLED=' "${VOICE_BRIDGE_DEST}/.env" 2>/dev/null \
          | tail -n 1 \
          | cut -d= -f2- \
          | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
      ) || true
    fi
    effective_voice_transcription_enabled="${VOICE_TRANSCRIPTION_ENABLED:-${prev_voice_transcription_enabled:-false}}"

    cat > .env <<VBENV_EOF
STREAM_URL_SIGNING_SECRET=${STREAM_URL_SIGNING_SECRET:-}
SUPABASE_URL=${SUPABASE_URL:-}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_KEY:-}
BUSINESS_ID=${BUSINESS_ID:-}
BRIDGE_MEDIA_WSS_ORIGIN=${BRIDGE_MEDIA_WSS_ORIGIN:-}
GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
GEMINI_LIVE_MODEL=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}
GEMINI_LIVE_ENABLED=${effective_gemini_live_enabled}
VOICE_TRANSCRIPTION_ENABLED=${effective_voice_transcription_enabled}

# Vault + Rowboat + platform app endpoints for Gemini Live tool calls.
# VAULT_PATH: where the bridge reads soul/identity/memory/website md.
# ROWBOAT_URL: Rowboat /chat endpoint reachable from the bridge container;
#              uses Docker's host-gateway alias because Rowboat listens on
#              the host's loopback interface.
# APP_BASE_URL: platform Next.js origin for /api/voice/tools/* adapters.
# ROWBOAT_GATEWAY_TOKEN: shared bearer used by both Rowboat and the bridge
#                        when calling the platform app.
VAULT_PATH=/vault
ROWBOAT_URL=${ROWBOAT_URL:-http://host.docker.internal:3000}
APP_BASE_URL=${APP_BASE_URL:-}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN:-}
VBENV_EOF
    chmod 600 .env

    # Post-write verification: every key below must be present AND non-empty,
    # otherwise the bridge will silently fall into degraded states (no TLS
    # origin → Telnyx 403; blank signing secret → every stream URL rejected;
    # blank supabase creds → heartbeats fail). Emit a WARN-level progress
    # event with the missing key list so Mission Control flags the deploy
    # without SSH. The bridge itself enforces these at startup, but surfacing
    # the list earlier avoids a container crash-loop diagnosis detour.
    #
    # Keep this list in sync with vps/voice-bridge/src/index.ts env reads.
    bridge_required_keys=(
      STREAM_URL_SIGNING_SECRET
      SUPABASE_URL
      SUPABASE_SERVICE_ROLE_KEY
      BUSINESS_ID
      BRIDGE_MEDIA_WSS_ORIGIN
      GEMINI_LIVE_MODEL
      GEMINI_LIVE_ENABLED
      # Rollout flag, not strictly required for bridge function (default "false"
      # disables transcripts and calls still work). Included here so the
      # post-write verification catches accidentally-blank writes — the
      # effective_* fallback above always resolves to "true" or "false", so a
      # blank line would indicate the env block was tampered with.
      VOICE_TRANSCRIPTION_ENABLED
    )
    missing_keys=()
    for key in "${bridge_required_keys[@]}"; do
      # Match `KEY=<non-empty>` — a bare `KEY=` counts as missing. Restrict
      # the regex to line-start so a commented `# KEY=foo` doesn't mask a
      # blank real entry (belt-and-braces: we don't write comments above).
      if ! grep -E "^${key}=.+" .env >/dev/null 2>&1; then
        missing_keys+=("$key")
      fi
    done
    if [[ ${#missing_keys[@]} -eq 0 ]]; then
      log "voice-bridge .env: all required keys present"
      # Use a distinct phase so the dashboard can treat this as informational
      # (doesn't override the later ready/unhealthy events). Piggyback on the
      # 96 band so it strictly precedes voice_bridge_ready (98).
      report_progress 96 "voice_bridge_env_verified" \
        "voice-bridge .env has ${#bridge_required_keys[@]} required keys"
    else
      # IFS-join without jq — keeps the message human-readable.
      joined=$(IFS=,; echo "${missing_keys[*]}")
      log "WARN: voice-bridge .env is missing required keys: ${joined}"
      report_progress 96 "voice_bridge_env_incomplete" \
        "voice-bridge .env missing required keys: ${joined}"
    fi

    if docker compose up -d --build --force-recreate; then
      # Poll liveness endpoint. Dockerfile exposes GET / → 200 OK.
      bridge_ok=0
      for _ in $(seq 1 20); do
        if curl -sf --max-time 3 http://127.0.0.1:8090/ >/dev/null 2>&1; then
          bridge_ok=1
          break
        fi
        sleep 2
      done
      if [[ "$bridge_ok" == "1" ]]; then
        # Progress must stay above step 5's 95 (business_online_patch) to remain
        # monotonic for Mission Control's progress bar. 100 is reserved by
        # `orchestrate.ts` for the terminal success event, so cap bridge
        # outcomes at <=98.
        report_progress 98 "voice_bridge_ready" "voice-bridge container healthy on :8090"
      else
        log "WARN: voice-bridge container started but GET http://127.0.0.1:8090/ never returned 200 within 40s"
        report_progress 97 "voice_bridge_unhealthy" "voice-bridge container started but never reached HTTP 200"
      fi
    else
      log "WARN: voice-bridge compose failed"
      report_progress 96 "voice_bridge_compose_failed" "docker compose up failed"
    fi
  )
else
  log "No ${VOICE_BRIDGE_DEST}/docker-compose.yml and no source at ${VOICE_BRIDGE_SRC} — skipping voice bridge container"
fi

log "=== Client deployment complete: ${BUSINESS_ID} ==="
