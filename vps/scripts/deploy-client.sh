#!/usr/bin/env bash
# deploy-client.sh — Provision a client-specific configuration on the VPS
# Called from the orchestration API after bootstrap.sh has run.
#
# Environment variables expected:
#   BUSINESS_ID              — UUID from Supabase
#   TIER                     — starter | standard (ENTITLEMENTS: drives the
#                               aiflow-render gate; hardware decisions key on
#                               VPS_SIZE)
#   VPS_SIZE                 — kvm1 | kvm2 | kvm4 | kvm8 (HARDWARE: drives the
#                               local Ollama fallback model — kvm1 has NONE: AI
#                               is Gemini-only and over-cap turns refuse; kvm2
#                               and kvm4 share the llama fallback; only kvm8
#                               carries qwen). The
#                               orchestrator ALWAYS passes this explicitly;
#                               the unset fallback below (starter→kvm1,
#                               standard→kvm8) only guards manual runs and may
#                               not match the box — always set VPS_SIZE.
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
#   OWNER_CHAT_MODEL         — optional; model for the OwnerCoworker (owner
#                               dashboard chat) agent. Defaults to
#                               gemini-2.5-flash-lite; degrades to OLLAMA_MODEL
#                               on a keyless host.
#   SMS_CHAT_MODEL           — optional; model for the Coworker (inbound SMS)
#                               agent. Defaults to gemini-2.5-flash-lite (shares
#                               the owner-chat spend cap; falls back to the
#                               CoworkerLocal/Qwen twin once tripped); degrades
#                               to OLLAMA_MODEL on a keyless host.
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
#   PROVISIONING_PROGRESS_URL — optional; POST JSON progress to app (see report_progress)
#   PROVISIONING_PROGRESS_TOKEN — Bearer token for progress API

set -euo pipefail

TIER="${TIER:-standard}"
if [[ -z "${VPS_SIZE:-}" ]]; then
  if [[ "$TIER" == "starter" ]]; then VPS_SIZE="kvm1"; else VPS_SIZE="kvm8"; fi
fi
# kvm1 carries no local Ollama model (bootstrap skips the install). Every
# local-fallback decision below keys on this flag instead of re-testing the
# size string.
if [[ "$VPS_SIZE" == "kvm1" ]]; then HAS_LOCAL_MODEL="false"; else HAS_LOCAL_MODEL="true"; fi
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

log "=== Deploying client: ${BUSINESS_ID} (TIER=${TIER}, VPS_SIZE=${VPS_SIZE}) ==="

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

# Hardware-aware model selection (local Ollama FALLBACK only — the primary
# chat/SMS path is Gemini via the llm-router; this model serves cap-tripped
# and outage turns).
# KVM1 (4GB): NO local model — Ollama is never installed; over-cap turns
# refuse instead of degrading (fleet economics Phase E decision).
# KVM2 (8GB) / KVM4 (16GB): **`llama3.2:3b`**. KVM8 (32GB CPU) only: **`qwen3:4b-instruct`**. Dual fast/balanced tags are for GPU hosts only.
if [[ "${HAS_LOCAL_MODEL}" == "false" ]]; then
  OLLAMA_MODEL=""
elif [[ "${VPS_SIZE}" == "kvm2" || "${VPS_SIZE}" == "kvm4" ]]; then
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

# Owner-dashboard chat model (OwnerCoworker agent only — SMS's Coworker agent
# stays on the local Ollama model for $0 marginal cost). The owner surface
# sends a long prompt every turn (agent instructions + OWNER_PREAMBLE + synced
# memory + recent tail) and is interactive, so the CPU-only local model's cold
# prompt prefill (~27 tok/s ⇒ ~100s+ on a fresh turn, growing with thread age)
# blew past the worker's Rowboat timeout. Routing OwnerCoworker through the
# llm-router to Gemini (gemini-* ⇒ Google) measured ~2.8s end-to-end and 100%
# correct vs ~100s+ on qwen, for ~$0.0003/turn (see debug/bench-* + the
# dashboard-chat-model-benchmark canvas). Override to a local tag (e.g.
# qwen3:4b-instruct) to fall back to fully-local owner chat.
OWNER_CHAT_MODEL_DEFAULT="gemini-2.5-flash-lite"
OWNER_CHAT_MODEL=${OWNER_CHAT_MODEL:-${OWNER_CHAT_MODEL_DEFAULT}}

# Safety fallback: a gemini-* OwnerCoworker model is only reachable when
# GOOGLE_API_KEY is set — the llm-router returns 503 for gemini-* routes with
# no key. Seeding Gemini on a keyless host would break owner dashboard chat on
# every turn (worse than the slow-but-working local model), so degrade to the
# local Ollama tag instead. Tenants with a key keep Gemini.
# On kvm1 there IS no local tag to degrade to — a keyless kvm1 host has no
# working AI at all, so fail the deploy loudly instead of shipping a tenant
# whose every chat/SMS turn 503s.
case "${OWNER_CHAT_MODEL}" in
  gemini-*)
    if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
      if [[ "${HAS_LOCAL_MODEL}" == "false" ]]; then
        log "FATAL: OWNER_CHAT_MODEL=${OWNER_CHAT_MODEL} requires GOOGLE_API_KEY and this ${VPS_SIZE} host has no local model to fall back to."
        exit 1
      fi
      log "WARNING: OWNER_CHAT_MODEL=${OWNER_CHAT_MODEL} requires GOOGLE_API_KEY but none is set; falling back to local ${OLLAMA_MODEL} for OwnerCoworker."
      OWNER_CHAT_MODEL="${OLLAMA_MODEL}"
    fi
    ;;
esac

# Inbound-SMS chat model (the `Coworker` startAgent). Repointed off local Qwen
# to Gemini 2.5 Flash-Lite for the same latency/quality win owner chat got — the
# CPU-only local model routinely took >20s for the first SMS reply. Gemini bills
# per token, so the SMS Edge worker shares the owner-chat $10/period fuse and
# falls back to the `CoworkerLocal` (Qwen) twin once the COMBINED spend trips the
# cap. Same keyless safety fallback as OWNER_CHAT_MODEL: a gemini-* tag needs
# GOOGLE_API_KEY (the llm-router 503s gemini-* without one), so degrade to the
# local tag on a keyless host. Override SMS_CHAT_MODEL to a local tag to keep SMS
# fully local.
SMS_CHAT_MODEL_DEFAULT="gemini-2.5-flash-lite"
SMS_CHAT_MODEL=${SMS_CHAT_MODEL:-${SMS_CHAT_MODEL_DEFAULT}}
case "${SMS_CHAT_MODEL}" in
  gemini-*)
    if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
      if [[ "${HAS_LOCAL_MODEL}" == "false" ]]; then
        log "FATAL: SMS_CHAT_MODEL=${SMS_CHAT_MODEL} requires GOOGLE_API_KEY and this ${VPS_SIZE} host has no local model to fall back to."
        exit 1
      fi
      log "WARNING: SMS_CHAT_MODEL=${SMS_CHAT_MODEL} requires GOOGLE_API_KEY but none is set; falling back to local ${OLLAMA_MODEL} for the SMS Coworker agent."
      SMS_CHAT_MODEL="${OLLAMA_MODEL}"
    fi
    ;;
esac

cat > /opt/rowboat/.env <<RENV_EOF
# Rowboat runtime configuration for business: ${BUSINESS_ID}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN}
BUSINESS_ID=${BUSINESS_ID}
TIER=${TIER}
VPS_SIZE=${VPS_SIZE}

# Upstream-required Rowboat keys.
#
# The pinned Rowboat fork (apps/rowboat) reads these at boot and crashes
# when any are missing — even when the corresponding feature is disabled.
# Source of truth for the list: vps/integration/real/fixtures/rowboat.env.kvm8.integration
# (kept in lockstep with the pinned upstream SHA).
#
# We deliberately keep auth + agents-api + copilot-api in the "test stub"
# state because:
#   * USE_AUTH=false bypasses Auth0 entirely (auth0 keys are placeholders).
#   * AGENTS_API / COPILOT_API run inside Rowboat itself; the *_URL=
#     127.0.0.1:9 placeholder keeps the boot-time validator happy without
#     spinning up extra services we don't use on the dispatcher path.
#   * USE_RAG=false disables qdrant; QDRANT_URL is set so retries don't hit
#     a JSON-parse error on the fallback path.
NODE_ENV=production
PORT=3000
MONGODB_CONNECTION_STRING=mongodb://mongo:27017/rowboat
REDIS_URL=redis://redis:6379
# OPENAI_API_KEY is intentionally NOT set. Rowboat's PROVIDER_API_KEY
# below takes precedence in every fallback chain (PROVIDER_API_KEY ||
# OPENAI_API_KEY) so the placeholder never gated model calls — but the
# OpenAI Agents SDK that Rowboat is built on auto-registered a tracing
# exporter against platform.openai.com using whatever key was on hand,
# generating one [non-fatal] 401 per request. OPENAI_AGENTS_DISABLE_TRACING
# kills the exporter outright. See PR #79 / docs/runbooks/dashboard-chat-vps.md.
OPENAI_AGENTS_DISABLE_TRACING=1
USE_AUTH=false
AUTH0_BASE_URL=http://127.0.0.1:3000
AUTH0_SECRET=test_secret
AUTH0_ISSUER_BASE_URL=https://test.invalid
AUTH0_CLIENT_ID=test
AUTH0_CLIENT_SECRET=test
AGENTS_API_URL=http://127.0.0.1:9
AGENTS_API_KEY=test
COPILOT_API_URL=http://127.0.0.1:9
COPILOT_API_KEY=test
USE_RAG=false
QDRANT_URL=http://qdrant:6333
QDRANT_API_KEY=

# LLM provider routing — Rowboat talks to the llm-router sidecar (same
# docker-compose network) which forwards to Ollama for dispatcher (SMS)
# and Gemini for voice_task (voice). The llm-router service uses its
# compose DNS alias; no host.docker.internal hop needed from Rowboat.
# On a no-local-model host (kvm1) OLLAMA_MODEL is empty; every seeded agent
# carries an explicit model, so the provider defaults only exist to satisfy
# Rowboat's boot-time validator — point them at the Gemini SMS model there.
PROVIDER_BASE_URL=http://llm-router:${LLM_ROUTER_PORT}/v1
PROVIDER_API_KEY=router
PROVIDER_DEFAULT_MODEL=${OLLAMA_MODEL:-${SMS_CHAT_MODEL}}
PROVIDER_COPILOT_MODEL=${OLLAMA_MODEL:-${SMS_CHAT_MODEL}}

# Gemini model used by the voice_task agent via the llm-router.
#
# The llm-router sidecar (env_file: this file) ALSO meters exact AI-chat-budget
# spend: for every gemini-* completion it proxies for the chat surfaces (owner
# chat, SMS, summarizers — NOT voice_task, which is GEMINI_ROWBOAT_MODEL and
# billed as voice minutes) it POSTs the billed tokens to
# ${APP_BASE_URL}/api/internal/meter-gemini-spend using ROWBOAT_GATEWAY_TOKEN.
# It therefore relies on BUSINESS_ID, APP_BASE_URL, ROWBOAT_GATEWAY_TOKEN (all
# written above) and GEMINI_ROWBOAT_MODEL (to exclude the voice path) being
# present in this env file — keep them here when editing.
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
#
# No-local-model hosts (kvm1) have no Ollama to keep warm — skip, and tear
# down any timer left behind by an earlier same-box life as kvm2.
# ------------------------------------------------------------------
if [[ "${HAS_LOCAL_MODEL}" == "false" ]]; then
  log "KVM 1: skipping ollama-keep-warm.timer (no local model)."
  systemctl disable --now ollama-keep-warm.timer 2>/dev/null || true
  rm -f /etc/systemd/system/ollama-keep-warm.service /etc/systemd/system/ollama-keep-warm.timer
  systemctl daemon-reload 2>/dev/null || true
else

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

fi # end HAS_LOCAL_MODEL keep-warm gate

# ------------------------------------------------------------------
# 3. Apply Rowboat stack.
#
# `--force-recreate` is mandatory: without it, `docker compose up` keeps
# the existing container alive when ONLY the env_file changed (compose
# only auto-recreates when image / yaml-level config diff). On a tenant
# re-deploy that rotates secrets (ROWBOAT_GATEWAY_TOKEN,
# STREAM_URL_SIGNING_SECRET) or adds a previously-missing key (the
# late-2025 MONGODB_CONNECTION_STRING / REDIS_URL / AUTH0_* additions),
# the running container would silently fall back to its in-image
# defaults and crash-loop on Redis ECONNREFUSED 127.0.0.1:6379.
#
# `--remove-orphans` drops the legacy `ollama` compose service from
# pre-2026-04 layouts that ran ollama inside the same compose project.
#
# Re-stage the llm-router source from the refreshed repo FIRST. The router's
# compose `build:` context is /opt/rowboat/llm-router, which bootstrap.sh
# populates on first boot but deploy-client.sh historically never refreshed.
# A fleet redeploy (redeploy-deploy-client.ts) re-pins /opt/newcoworker-repo
# to the requested ref, but `docker compose up --build` rebuilds the router
# from the STALE /opt/rowboat/llm-router copy — silently shipping pre-merge
# router code (e.g. the router never picks up exact AI-chat-budget metering)
# while still stamping a fresh image timestamp. Mirror bootstrap.sh's staging
# so every deploy rebuilds the sidecar from THIS deploy's code.
LLM_ROUTER_SRC="${LLM_ROUTER_SRC:-/opt/newcoworker-repo/vps/llm-router}"
LLM_ROUTER_DEST="/opt/rowboat/llm-router"
if [[ -d "${LLM_ROUTER_SRC}" ]]; then
  mkdir -p "${LLM_ROUTER_DEST}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude "node_modules" "${LLM_ROUTER_SRC}/" "${LLM_ROUTER_DEST}/"
  else
    cp -R "${LLM_ROUTER_SRC}/." "${LLM_ROUTER_DEST}/"
  fi
  log "llm-router source re-staged at ${LLM_ROUTER_DEST}"
else
  log "WARN: llm-router source not found at ${LLM_ROUTER_SRC}; compose build will reuse existing ${LLM_ROUTER_DEST}"
fi

docker compose -f /opt/rowboat/docker-compose.yml up -d --build --force-recreate --remove-orphans || true
log "Rowboat stack updated."

# Bands align with integration ordering: stack up → HTTP readiness → tunnel → Supabase patch (see vps/integration/README.md).
report_progress 68 "rowboat_stack" "Docker Compose stack updated"

if curl -sf --max-time 15 http://127.0.0.1:3000/health >/dev/null 2>&1 || curl -sf --max-time 15 http://127.0.0.1:3000/ >/dev/null 2>&1; then
  report_progress 78 "rowboat_http" "Rowboat HTTP endpoint reachable"
else
  log "WARN: Rowboat /health HTTP check failed (containers may still be warming)"
fi

# ------------------------------------------------------------------
# 3b. Seed the per-tenant Rowboat project + api_key
#
# Rowboat does not expose a public REST API for project creation — projects
# live as documents in the bundled MongoDB. We use the same pattern the
# integration tests use (see tests/integration/kvm-rowboat/mongo-seed.ts):
# stage a mongosh script, copy it into the mongo container, and run it.
#
# Why this is mandatory: /api/dashboard/chat reads
# `business_configs.rowboat_project_id` and POSTs to
# `https://<biz>.newcoworker.com/api/v1/<projectId>/chat`. Rowboat
# rejects unknown projectIds with HTTP 404, which the dashboard surfaces
# as "your coworker's chat service isn't ready yet" — even when every
# container is healthy. Seeding here closes that gap on the deploy path.
#
# Schema notes:
#   * `_id` is the projectId. We use BUSINESS_ID directly so the same
#     identifier flows through Supabase → tunnel hostname → Rowboat URL.
#   * `api_keys` row uses `key = ROWBOAT_GATEWAY_TOKEN` so the bearer
#     the platform Next.js app sends from /api/dashboard/chat
#     authenticates one-shot. Same shared bearer the voice-bridge uses.
#   * `liveWorkflow.agents[0]` is a "conversation" agent populated from
#     the tenant's soul.md / identity.md / memory.md. The platform's
#     chat copy expects a `user_facing` agent; mirror upstream.
#   * Idempotent: deleteMany then insertOne, matched on _id / projectId.
# ------------------------------------------------------------------
log "Seeding Rowboat project ${BUSINESS_ID}..."
SEED_TMP=$(mktemp /tmp/rowboat-seed.XXXXXX.js)
chmod 600 "${SEED_TMP}"

# Build the workflow JSON safely with jq so embedded quotes / newlines in
# the .md vault files don't break mongosh parsing. Empty md files collapse
# to empty strings, which Rowboat tolerates — the agent just runs with
# whatever instructions are non-empty.
ROWBOAT_INSTRUCTIONS=$(jq -nRs --arg soul "$SOUL_MD" --arg id "$IDENTITY_MD" --arg mem "$MEMORY_MD" --arg web "$WEBSITE_MD" '
  ([$id, $soul, $web, $mem] | map(select(length > 0)) | join("\n\n"))
' || echo "")
ROWBOAT_INSTRUCTIONS=${ROWBOAT_INSTRUCTIONS:-"You are a professional AI coworker. Reply concisely and helpfully."}

# Write the seed script. We embed the project + key docs as Mongo extended
# JSON so booleans, dates, and special chars round-trip cleanly.
SEED_NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
# Project tool webhook: when APP_BASE_URL is known, workflow tools are
# marked isWebhook and Rowboat POSTs tool calls to the platform dispatcher
# (/api/rowboat/tool-call) which fulfils them for real and enforces the
# owner's Settings → Coworker tools toggles. Without APP_BASE_URL the
# tools stay placeholder (LLM-mocked) — the pre-webhook behavior — because
# isWebhook tools with no webhookUrl make Rowboat throw mid-turn.
ROWBOAT_TOOL_WEBHOOK_URL=""
if [[ -n "${APP_BASE_URL:-}" ]]; then
  ROWBOAT_TOOL_WEBHOOK_URL="${APP_BASE_URL%/}/api/rowboat/tool-call"
else
  log "WARN: APP_BASE_URL unset — Rowboat workflow tools stay mocked (no tool webhook)"
fi

# On a no-local-model host (kvm1) the Local twin agents are seeded DISABLED
# and pinned to the Gemini model (their $model arg must be non-empty for
# Rowboat's validator, but they are never routed to: the platform/edge/worker
# cap logic refuses over-cap turns on kvm1 instead of downgrading).
WORKFLOW_JSON=$(jq -nc \
  --arg name "${BUSINESS_NAME:-AI Coworker}" \
  --arg instructions "${ROWBOAT_INSTRUCTIONS}" \
  --arg model "${OLLAMA_MODEL:-${SMS_CHAT_MODEL}}" \
  --arg ownerModel "${OWNER_CHAT_MODEL}" \
  --arg smsModel "${SMS_CHAT_MODEL}" \
  --arg hasLocal "${HAS_LOCAL_MODEL}" \
  --arg webhookUrl "${ROWBOAT_TOOL_WEBHOOK_URL}" \
  --arg now "${SEED_NOW}" '
($webhookUrl != "") as $toolsAreReal |
($hasLocal != "true") as $localAgentsDisabled |
{
  agents: [
    {
      name: "Coworker",
      type: "conversation",
      description: "Per-tenant AI coworker (inbound SMS startAgent)",
      disabled: false,
      instructions: $instructions,
      outputVisibility: "user_facing",
      controlType: "retain",
      # Gemini via the llm-router (gemini-* => Google) — see SMS_CHAT_MODEL
      # above. Repointed off local Qwen: the CPU-only model routinely took
      # >20s for the first SMS reply. The SMS Edge worker meters Gemini turns
      # into the shared owner-chat fuse and, once the COMBINED period spend
      # crosses the cap, forces a stateless turn on CoworkerLocal (below).
      model: $smsModel,
      ragK: 3,
      ragReturnType: "chunks",
      # Phase 5 cross-channel customer-memory tools. Declared at the agent
      # level so the SMS dispatcher (Ollama-backed) can invoke them in the
      # same way the voice path already does via Gemini Live (see
      # vps/voice-bridge/src/gemini-telnyx-bridge.ts:buildVoiceToolDeclarations).
      # The bridge advertises them to Gemini Live directly; this entry is
      # the gating layer for the Rowboat-mediated SMS path.
      # owner_append_business_memory is NOT listed here — it is owner-dashboard
      # only on OwnerCoworker (see second agent below).
      tools: [
        "customer_lookup_by_phone",
        "customer_set_display_name",
        "customer_append_pinned_note",
        "business_knowledge_lookup",
        "calendar_find_slots",
        "calendar_book_appointment",
        "send_email"
      ]
    },
    {
      name: "CoworkerLocal",
      type: "conversation",
      # SMS spend-cap fallback twin of Coworker. Identical tool surface and
      # instructions, but pinned to the LOCAL Ollama model ($0 marginal cost).
      # The SMS Edge worker forces startAgent=CoworkerLocal on a STATELESS turn
      # once a business crosses the shared owner+SMS spend cap for the period
      # (Rowboat ignores startAgent when a conversationId is supplied, so the
      # switch only takes effect statelessly). Free but slower (CPU prefill), so
      # a runaway burst degrades to local instead of billing unbounded Gemini.
      description: "Inbound-SMS spend-cap fallback: identical to Coworker but on the local model.",
      disabled: $localAgentsDisabled,
      instructions: $instructions,
      outputVisibility: "user_facing",
      controlType: "retain",
      model: $model,
      ragK: 3,
      ragReturnType: "chunks",
      tools: [
        "customer_lookup_by_phone",
        "customer_set_display_name",
        "customer_append_pinned_note",
        "business_knowledge_lookup",
        "calendar_find_slots",
        "calendar_book_appointment",
        "send_email"
      ]
    },
    {
      name: "OwnerCoworker",
      type: "conversation",
      description: "Owner dashboard chat: same tool surface as Coworker plus owner_append_business_memory.",
      disabled: false,
      instructions: $instructions,
      outputVisibility: "user_facing",
      controlType: "retain",
      # Gemini via the llm-router (gemini-* ⇒ Google) — see OWNER_CHAT_MODEL
      # above. The interactive owner surface needs sub-second-class latency the
      # CPU-only local model cannot give on its long per-turn prompt.
      model: $ownerModel,
      ragK: 3,
      ragReturnType: "chunks",
      # Dashboard surface declares its own customer-tool names so the
      # platform dispatcher can attribute the call (the Rowboat webhook
      # payload has no agent context) — distinct Settings toggles and an
      # honest interaction channel ("dashboard", not "sms").
      tools: [
        "dashboard_customer_lookup_by_phone",
        "dashboard_customer_set_display_name",
        "dashboard_customer_append_pinned_note",
        "owner_append_business_memory",
        "send_sms",
        "dashboard_business_knowledge_lookup",
        "dashboard_calendar_find_slots",
        "dashboard_calendar_book_appointment"
      ]
    },
    {
      name: "OwnerCoworkerLocal",
      type: "conversation",
      # Spend-cap fallback twin of OwnerCoworker. Identical tool surface and
      # instructions, but pinned to the LOCAL Ollama model ($0 marginal cost).
      # The owner-chat enqueue route flips a job to startAgent=OwnerCoworkerLocal
      # once a business crosses its per-period owner-chat spend cap; the worker
      # honors the per-job startAgent. Slower (CPU prefill) but free, so a
      # runaway loop degrades to local instead of billing unbounded Gemini.
      description: "Owner dashboard chat spend-cap fallback: identical to OwnerCoworker but on the local model.",
      disabled: $localAgentsDisabled,
      instructions: $instructions,
      outputVisibility: "user_facing",
      controlType: "retain",
      model: $model,
      ragK: 3,
      ragReturnType: "chunks",
      tools: [
        "dashboard_customer_lookup_by_phone",
        "dashboard_customer_set_display_name",
        "dashboard_customer_append_pinned_note",
        "owner_append_business_memory",
        "send_sms",
        "dashboard_business_knowledge_lookup",
        "dashboard_calendar_find_slots",
        "dashboard_calendar_book_appointment"
      ]
    }
  ],
  prompts: [{
    name: "baseline",
    type: "base_prompt",
    prompt: "Owner-facing assistant for \($name)."
  }],
  # Workflow-level tool registry. Each entry maps the tool name advertised
  # to the LLM to the platform Next.js adapter that fulfils it. Keep this
  # in lockstep with vps/voice-bridge/src/gemini-telnyx-bridge.ts:voiceToolPath.
  # NOTE: descriptions are deliberately apostrophe-free because the
  # surrounding bash heredoc opens this jq filter with single quotes;
  # any embedded apostrophe would close the literal early.
  # `isWebhook: $toolsAreReal` routes these through the project tool
  # webhook (/api/rowboat/tool-call) for REAL fulfilment + per-tool
  # Settings enforcement. The webhook payload carries no caller context,
  # so `phone` is REQUIRED on this path (the voice bridge keeps its own
  # tool declarations with optional phone — see
  # vps/voice-bridge/src/gemini-telnyx-bridge.ts).
  tools: [
    {
      name: "customer_lookup_by_phone",
      description: "Look up the cross-channel customer profile (display name, rolling summary, last channel/date, total interaction count) for a customer phone number.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "E.164 phone to look up, e.g. +15551234567."
          }
        },
        required: ["phone"]
      }
    },
    {
      name: "customer_set_display_name",
      description: "Persist the customer name on their profile so future calls/SMS recognize them. Will not overwrite a name the owner already set from the dashboard.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description: "The customer name. Will be normalized server-side."
          },
          phone: {
            type: "string",
            description: "E.164 phone to attribute the name to."
          }
        },
        required: ["displayName", "phone"]
      }
    },
    {
      name: "customer_append_pinned_note",
      description: "Append a permanent fact to this customer pinned notes (e.g. allergies, scheduling constraints). The note survives every future summary. Use sparingly.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The fact to pin, in the customer words. Keep concise."
          },
          phone: {
            type: "string",
            description: "E.164 phone to attribute the note to."
          }
        },
        required: ["note", "phone"]
      }
    },
    {
      name: "send_sms",
      description: "Send a text message from the business number to any phone number. Use ONLY when the owner explicitly asks in dashboard chat for a text to be sent. Never invent recipients.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          toE164: {
            type: "string",
            description: "Recipient phone in E.164, e.g. +15551234567."
          },
          body: {
            type: "string",
            description: "Plain-text message body, at most 1600 characters."
          }
        },
        required: ["toE164", "body"]
      }
    },
    {
      name: "send_email",
      description: "Send a short plain-text follow-up email to a customer from the owner connected mailbox. Use ONLY when the customer asks for information by email or agrees to receive one. Never invent recipients.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          toEmail: {
            type: "string",
            description: "Recipient email address."
          },
          subject: {
            type: "string",
            description: "Short subject line, at most 150 characters."
          },
          bodyText: {
            type: "string",
            description: "Plain-text body, 1-3 short paragraphs, at most 4000 characters."
          },
          cc: {
            type: "array",
            items: { type: "string" },
            description: "Optional cc email addresses, at most 10. Only use addresses the owner/customer gave you."
          },
          bcc: {
            type: "array",
            items: { type: "string" },
            description: "Optional bcc email addresses, at most 10. Only use addresses the owner/customer gave you."
          }
        },
        required: ["toEmail", "subject", "bodyText"]
      }
    },
    {
      name: "business_knowledge_lookup",
      description: "Answer a business-specific question (hours, services, pricing, policies) from the business knowledge base and website summary. Use when the answer is not already in your instructions.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to answer, in plain words."
          }
        },
        required: ["question"]
      }
    },
    {
      name: "calendar_find_slots",
      description: "Find up to 3 free time ranges on the owner connected calendar. Use before proposing appointment times.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          purpose: { type: "string", description: "What the appointment is for." },
          earliest: { type: "string", description: "Earliest acceptable start, ISO 8601. Defaults to now." },
          latest: { type: "string", description: "Latest acceptable end, ISO 8601. Defaults to 7 days out." },
          durationMinutes: { type: "number", description: "Appointment length in minutes. Defaults to 30." },
          timezone: { type: "string", description: "IANA timezone of the requester, if known." }
        },
        required: []
      }
    },
    {
      name: "calendar_book_appointment",
      description: "Book an appointment on the owner connected calendar. Confirm the time with the customer before booking. Times must be ISO 8601 with timezone offset.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          startIso: { type: "string", description: "Start time, ISO 8601." },
          endIso: { type: "string", description: "End time, ISO 8601." },
          summary: { type: "string", description: "Short event title." },
          attendeeName: { type: "string", description: "Customer name for the event." },
          attendeeEmail: { type: "string", description: "Customer email, if provided." },
          attendeePhone: { type: "string", description: "Customer phone, if known." },
          notes: { type: "string", description: "Extra context for the event description." },
          timezone: { type: "string", description: "IANA timezone for the event times." }
        },
        required: ["startIso", "endIso", "summary", "attendeeName"]
      }
    },
    # Dashboard-surface twins (see the OwnerCoworker comment above). Same
    # dispatcher cores, separate Settings toggle per surface.
    {
      name: "dashboard_business_knowledge_lookup",
      description: "Answer an owner question from the business knowledge base and website summary when the answer is not already in your instructions.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to answer, in plain words."
          }
        },
        required: ["question"]
      }
    },
    {
      name: "dashboard_calendar_find_slots",
      description: "Find up to 3 free time ranges on the owner connected calendar when the owner asks about availability.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          purpose: { type: "string", description: "What the appointment is for." },
          earliest: { type: "string", description: "Earliest acceptable start, ISO 8601. Defaults to now." },
          latest: { type: "string", description: "Latest acceptable end, ISO 8601. Defaults to 7 days out." },
          durationMinutes: { type: "number", description: "Appointment length in minutes. Defaults to 30." },
          timezone: { type: "string", description: "IANA timezone, if known." }
        },
        required: []
      }
    },
    {
      name: "dashboard_calendar_book_appointment",
      description: "Book an appointment on the owner connected calendar when the owner asks for it in dashboard chat. Times must be ISO 8601 with timezone offset.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          startIso: { type: "string", description: "Start time, ISO 8601." },
          endIso: { type: "string", description: "End time, ISO 8601." },
          summary: { type: "string", description: "Short event title." },
          attendeeName: { type: "string", description: "Attendee name for the event." },
          attendeeEmail: { type: "string", description: "Attendee email, if provided." },
          attendeePhone: { type: "string", description: "Attendee phone, if known." },
          notes: { type: "string", description: "Extra context for the event description." },
          timezone: { type: "string", description: "IANA timezone for the event times." }
        },
        required: ["startIso", "endIso", "summary", "attendeeName"]
      }
    },
    # Dashboard-surface twins of the customer tools (see the OwnerCoworker
    # comment above). Same dispatcher cores, separate toggle + channel.
    {
      name: "dashboard_customer_lookup_by_phone",
      description: "Look up the cross-channel customer profile (display name, rolling summary, last channel/date, total interaction count) for a customer phone number the owner asks about.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "E.164 phone to look up, e.g. +15551234567."
          }
        },
        required: ["phone"]
      }
    },
    {
      name: "dashboard_customer_set_display_name",
      description: "Persist a customer name on their profile when the owner states it in dashboard chat. Will not overwrite a name the owner already set from the customers page.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description: "The customer name. Will be normalized server-side."
          },
          phone: {
            type: "string",
            description: "E.164 phone to attribute the name to."
          }
        },
        required: ["displayName", "phone"]
      }
    },
    {
      name: "dashboard_customer_append_pinned_note",
      description: "Append a permanent fact to a customer pinned notes when the owner states it in dashboard chat. The note survives every future summary. Use sparingly.",
      isWebhook: $toolsAreReal,
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The fact to pin, in the owner words. Keep concise."
          },
          phone: {
            type: "string",
            description: "E.164 phone to attribute the note to."
          }
        },
        required: ["note", "phone"]
      }
    },
    {
      name: "owner_append_business_memory",
      description: (
        "Persist a lasting business-wide rule the OWNER stated in Dashboard chat only. " +
        "Examples: never ask leads for budget, required brokerage disclaimer, hours you will mention to leads. " +
        "Call ONLY when the current user message is owner Dashboard guidance (not a customer SMS or call). " +
        "NEVER call for messages from customers. NEVER invent rules. " +
        "Use concise bullets: one rule per line in bullets."
      ),
      parameters: {
        type: "object",
        properties: {
          bullets: {
            type: "string",
            description: "One lasting rule per line. Imperative short lines."
          }
        },
        required: ["bullets"]
      }
    }
  ],
  startAgent: "Coworker",
  lastUpdatedAt: $now
}')

cat > "${SEED_TMP}" <<MONGOSH_EOF
const projectId = "${BUSINESS_ID}";
const apiKey = "${ROWBOAT_GATEWAY_TOKEN}";
const workflow = ${WORKFLOW_JSON};
const now = "${SEED_NOW}";
db.projects.deleteMany({ _id: projectId });
db.projects.insertOne({
  _id: projectId,
  name: "${BUSINESS_NAME:-AI Coworker}",
  createdAt: now,
  createdByUserId: "newcoworker-orchestrator",
  // Signs the x-signature-jwt on tool-webhook POSTs. Uses the same shared
  // gateway token the platform already holds (ROWBOAT_GATEWAY_TOKEN) so
  // /api/rowboat/tool-call can verify with one env var. Falls back to the
  // legacy per-deploy string when the token is absent (webhook tools are
  // also disabled in that case — see ROWBOAT_TOOL_WEBHOOK_URL above).
  secret: "${ROWBOAT_GATEWAY_TOKEN:-deploy-${BUSINESS_ID}}",
  // Project-level tool webhook: Rowboat POSTs isWebhook tool calls here.
  // Empty string when APP_BASE_URL is unknown (tools stay mocked).
  webhookUrl: "${ROWBOAT_TOOL_WEBHOOK_URL}",
  draftWorkflow: workflow,
  liveWorkflow: workflow
});
db.api_keys.deleteMany({ projectId: projectId });
db.api_keys.insertOne({ projectId: projectId, key: apiKey, createdAt: now });
print(JSON.stringify({
  projects: db.projects.countDocuments({ _id: projectId }),
  keys: db.api_keys.countDocuments({ projectId: projectId })
}));
MONGOSH_EOF

# Wait up to ~90s for mongo to be reachable. On a cold deploy the
# `--force-recreate` above just restarted Mongo and it can take 5-15s
# for it to accept connections.
seed_mongo_ok=0
for _ in $(seq 1 30); do
  if docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' rowboat 2>/dev/null | grep -q '^1$'; then
    seed_mongo_ok=1
    break
  fi
  sleep 3
done

if [[ "${seed_mongo_ok}" == "1" ]]; then
  if docker compose -f /opt/rowboat/docker-compose.yml cp "${SEED_TMP}" mongo:/tmp/rowboat.seed.js \
    && docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh rowboat /tmp/rowboat.seed.js > /tmp/rowboat-seed.out 2>&1; then
    log "Rowboat project seeded: $(tail -1 /tmp/rowboat-seed.out)"
    # Persist the projectId on `business_configs` so /api/dashboard/chat
    # picks it up without a code change. Patch is idempotent (PATCH not
    # POST) and `prefer=resolution=merge-duplicates` prevents a duplicate-
    # row error when a previous deploy already wrote the same value.
    if curl -sf -X PATCH \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
      -H "Content-Type: application/json" \
      -H "Prefer: return=minimal" \
      -d "{\"rowboat_project_id\": \"${BUSINESS_ID}\"}" \
      "${SUPABASE_URL}/rest/v1/business_configs?business_id=eq.${BUSINESS_ID}" \
      > /dev/null; then
      log "business_configs.rowboat_project_id set to ${BUSINESS_ID}"
      report_progress 80 "rowboat_project_seeded" "Rowboat project + business_configs.rowboat_project_id ready"
    else
      log "WARN: failed to PATCH business_configs.rowboat_project_id; chat will 409 until set manually"
      report_progress 80 "rowboat_project_seeded_no_config" "Rowboat project seeded but business_configs PATCH failed"
    fi
  else
    log "WARN: Rowboat mongo seed script failed: $(tail -3 /tmp/rowboat-seed.out 2>/dev/null || echo '<no output>')"
  fi
else
  log "WARN: rowboat mongo never reached ping=1 within 90s; skipping project seed (chat will 409 until next deploy)"
fi
rm -f "${SEED_TMP}" /tmp/rowboat-seed.out

# ------------------------------------------------------------------
# 4. Set up cloudflared tunnel
# ------------------------------------------------------------------
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  if [[ -f /etc/systemd/system/cloudflared.service ]]; then
    # `cloudflared service install <TOKEN>` refuses to run when the unit
    # already exists ("cloudflared service is already installed at
    # /etc/systemd/system/cloudflared.service ... if you are really sure,
    # you can do `cloudflared service uninstall`"). Re-running deploy on
    # an already-provisioned VPS used to surface this as a fatal exit
    # code, masking real downstream failures. Treat re-installs as a
    # restart instead — the token is encoded into the existing unit and
    # only changes during a manual rotation, which an operator handles
    # explicitly via `cloudflared service uninstall && deploy-client.sh`.
    log "cloudflared service already installed; restarting to pick up any compose changes"
    systemctl enable cloudflared || true
    systemctl restart cloudflared || true
  else
    log "Configuring cloudflared tunnel..."
    cloudflared service install "${CLOUDFLARE_TUNNEL_TOKEN}"
    systemctl enable cloudflared
    systemctl start cloudflared
  fi
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

    prev_bridge_media_wss_origin=""
    if [[ -f "${VOICE_BRIDGE_DEST}/.env" ]]; then
      prev_bridge_media_wss_origin=$(
        grep -E '^BRIDGE_MEDIA_WSS_ORIGIN=' "${VOICE_BRIDGE_DEST}/.env" 2>/dev/null \
          | tail -n 1 \
          | cut -d= -f2- \
          | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
      ) || true
    fi
    # Precedence: deploy env (orchestrator / redeploy-deploy-client.ts), then
    # value already on disk — avoids blanking wss:// on fleet redeploy when the
    # operator shell has no per-tenant origin.
    effective_bridge_media_wss_origin="${BRIDGE_MEDIA_WSS_ORIGIN:-${prev_bridge_media_wss_origin:-}}"

    cat > .env <<VBENV_EOF
STREAM_URL_SIGNING_SECRET=${STREAM_URL_SIGNING_SECRET:-}
SUPABASE_URL=${SUPABASE_URL:-}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_KEY:-}
BUSINESS_ID=${BUSINESS_ID:-}
BRIDGE_MEDIA_WSS_ORIGIN=${effective_bridge_media_wss_origin:-}
GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
GEMINI_LIVE_MODEL=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}
GEMINI_LIVE_ENABLED=${effective_gemini_live_enabled}
VOICE_TRANSCRIPTION_ENABLED=${effective_voice_transcription_enabled}
# TELNYX_API_KEY powers the bridge's Telnyx Call Control actions: the `end_call`
# hangup tool, the `transfer_to_owner` warm transfer, and the missed-call SMS
# fallback (see vps/voice-bridge/src/index.ts). Without it the bridge silently
# omits the hangup tool and every transfer returns "transfer not configured".
TELNYX_API_KEY=${TELNYX_API_KEY:-}

# Vault + Rowboat + platform app endpoints for Gemini Live tool calls.
# VAULT_PATH: where the bridge reads soul/identity/memory/website md.
# ROWBOAT_URL: Rowboat /chat endpoint reachable from the bridge container.
#              Uses Docker DNS via the shared `rowboat_default` network
#              (attached in vps/voice-bridge/docker-compose.yml). The old
#              `host.docker.internal:3000` default does NOT work because
#              Rowboat publishes 127.0.0.1:3000 only — the host gateway
#              IP isn't listening, so every request hangs ~30s and the
#              caller hears silence (May 2026 outage).
# APP_BASE_URL: platform Next.js origin for /api/voice/tools/* adapters.
# ROWBOAT_GATEWAY_TOKEN: shared bearer used by both Rowboat and the bridge
#                        when calling the platform app.
VAULT_PATH=/vault
ROWBOAT_URL=${ROWBOAT_URL:-http://rowboat:3000}
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
      # Required because every voice tenant is on Telnyx: a blank key disables
      # the AI's hangup (`end_call`) and warm-transfer (`transfer_to_owner`)
      # tools plus the missed-call SMS fallback, all silently.
      TELNYX_API_KEY
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

# ------------------------------------------------------------------
# 7. Dashboard chat-worker (Option B): drains dashboard_chat_jobs and
#    writes assistant messages back to Supabase.
#
# Replaces the in-Vercel streaming POST /api/dashboard/chat path that
# was capped by Vercel's maxDuration ceiling and dropped messages on
# any disconnect inside that window. See:
#   - supabase/migrations/20260508000000_dashboard_chat_jobs.sql
#   - vps/chat-worker/worker.mjs
#   - PR #79 cover letter
#
# Same sync model as the voice-bridge above: rsync from the staged repo,
# rewrite .env every deploy (so SUPABASE_SERVICE_KEY rotations land),
# `--force-recreate` so a changed .env restarts the container even when
# the image layer is cached.
# ------------------------------------------------------------------
CHAT_WORKER_SRC="${CHAT_WORKER_SRC:-/opt/newcoworker-repo/vps/chat-worker}"
CHAT_WORKER_DEST="/opt/chat-worker"

if [[ -d "${CHAT_WORKER_SRC}" && -f "${CHAT_WORKER_SRC}/docker-compose.yml" ]]; then
  log "Syncing chat-worker source ${CHAT_WORKER_SRC} → ${CHAT_WORKER_DEST}..."
  mkdir -p "${CHAT_WORKER_DEST}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude ".env" \
      --exclude "node_modules" \
      "${CHAT_WORKER_SRC}/" "${CHAT_WORKER_DEST}/"
  else
    log "rsync not installed; falling back to cp -R (no --delete)"
    cp -R "${CHAT_WORKER_SRC}/." "${CHAT_WORKER_DEST}/"
  fi
fi

if [[ -f "${CHAT_WORKER_DEST}/docker-compose.yml" ]]; then
  log "Starting chat-worker from ${CHAT_WORKER_DEST}..."
  (
    cd "${CHAT_WORKER_DEST}"

    # ROWBOAT_PROJECT_ID == BUSINESS_ID in our deployments (the per-tenant
    # Rowboat is keyed by the same UUID), but the worker takes them as
    # separate env vars to keep Rowboat's identifier model decoupled.
    # WORKER_VERCEL_BASE_URL + WORKER_VERCEL_BEARER are passed through
    # only when both are present in the deploy environment. Missing
    # values are equivalent to "rolling-summary callbacks disabled" —
    # the worker logs a warn and keeps processing jobs normally.
    # APP_BASE_URL is the canonical source for the Vercel base URL —
    # orchestrate.ts exports it by this name (see line 850 of
    # orchestrate.ts). INTERNAL_CRON_SECRET is the same secret asserted
    # by /api/internal/* routes via assertCronAuth in src/lib/cron-auth.ts.
    # Resolve the owner-rule capture model BEFORE writing .env — the heredoc
    # below only EMITS values, so shell control flow placed inside it would be
    # written to .env as literal text and never run. Defaults to Gemini via the
    # llm-router; the CPU-only local model always timed out (~30s, saving
    # nothing) AND its CPU load inflated concurrent Gemini chat turns from ~7s to
    # ~50s. A gemini-* model needs GOOGLE_API_KEY (the router 503s gemini-*
    # without one), so on a keyless host degrade capture to the local Ollama tag
    # — same fallback policy as OWNER_CHAT_MODEL above.
    MEMORY_CAPTURE_MODEL_DEFAULT="gemini-2.5-flash-lite"
    MEMORY_CAPTURE_MODEL="${MEMORY_CAPTURE_MODEL:-${MEMORY_CAPTURE_MODEL_DEFAULT}}"
    # Match the worker's OWN gemini detection (extractOwnerRule uses
    # /^gemini[-_.]/i — case-insensitive, with -, _, or . as the separator), so
    # any model the worker would route to the router (e.g. "Gemini-…",
    # "gemini_…") also trips the keyless fallback here. Lowercase first, then
    # match the three separators.
    memory_capture_model_lc="$(printf '%s' "${MEMORY_CAPTURE_MODEL}" | tr '[:upper:]' '[:lower:]')"
    case "${memory_capture_model_lc}" in
      gemini-*|gemini_*|gemini.*)
        if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
          if [[ "${HAS_LOCAL_MODEL}" == "false" ]]; then
            # kvm1 has no local tag to degrade capture to; capture is a
            # best-effort background step, so disable it rather than fail.
            log "WARNING: MEMORY_CAPTURE_MODEL=${MEMORY_CAPTURE_MODEL} requires GOOGLE_API_KEY and this host has no local model — disabling owner-rule capture."
            MEMORY_CAPTURE_ENABLED="false"
          else
            log "WARNING: MEMORY_CAPTURE_MODEL=${MEMORY_CAPTURE_MODEL} requires GOOGLE_API_KEY but none is set; falling back to local ${OLLAMA_MODEL} for owner-rule capture."
            MEMORY_CAPTURE_MODEL="${OLLAMA_MODEL}"
          fi
        fi
        ;;
    esac

    # Over-cap owner-chat routing target. On hosts WITH a local model this is
    # the OwnerCoworkerLocal twin (seeded above); on kvm1 it is EMPTY, which
    # tells the worker to REFUSE over-cap turns with an honest "budget used
    # up" reply instead of routing to an agent that cannot run.
    if [[ "${HAS_LOCAL_MODEL}" == "true" ]]; then
      CHAT_WORKER_OWNER_LOCAL_AGENT_VALUE="${CHAT_WORKER_OWNER_LOCAL_AGENT-OwnerCoworkerLocal}"
    else
      CHAT_WORKER_OWNER_LOCAL_AGENT_VALUE=""
    fi

    cat > "${CHAT_WORKER_DEST}/.env" <<CWENV_EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_KEY}
ROWBOAT_BASE_URL=http://rowboat:3000
ROWBOAT_PROJECT_ID=${BUSINESS_ID}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN}
BUSINESS_ID=${BUSINESS_ID}
WORKER_VERCEL_BASE_URL=${APP_BASE_URL:-${WORKER_VERCEL_BASE_URL:-}}
WORKER_VERCEL_BEARER=${INTERNAL_CRON_SECRET:-${WORKER_VERCEL_BEARER:-}}
# Owner-dashboard entry agent. This same deploy seeds the OwnerCoworker
# agent (above), so the worker routes owner chat to it. Override to ""
# (omit startAgent → workflow default "Coworker") only if intentionally
# running a workflow without OwnerCoworker. NOTE the `-` (not `:-`): an
# operator who explicitly exports CHAT_WORKER_OWNER_START_AGENT="" MUST get
# an empty value preserved (that's the escape hatch), so only an *unset*
# variable falls back to OwnerCoworker.
CHAT_WORKER_OWNER_START_AGENT=${CHAT_WORKER_OWNER_START_AGENT-OwnerCoworker}
# Over-cap fallback agent. Empty on no-local-model hosts (kvm1): the worker
# then refuses over-cap turns instead of downgrading to a local agent.
CHAT_WORKER_OWNER_LOCAL_AGENT=${CHAT_WORKER_OWNER_LOCAL_AGENT_VALUE}
# Owner-rule memory capture. After each owner turn the worker runs a background
# extraction over the owner message and, when it states a durable business rule,
# POSTs to WORKER_VERCEL_BASE_URL/api/voice/tools/owner-append-business-memory
# (bearer = ROWBOAT_GATEWAY_TOKEN) to persist it. The capture model is resolved
# above (Gemini via the llm-router by default, with keyless fallback to local).
MEMORY_CAPTURE_ENABLED=${MEMORY_CAPTURE_ENABLED:-true}
MEMORY_CAPTURE_MODEL=${MEMORY_CAPTURE_MODEL}
# Local Ollama (used only when MEMORY_CAPTURE_MODEL is a non-gemini tag) reached
# via the host.docker.internal extra_host wired in docker-compose.yml.
OLLAMA_BASE_URL=${CHAT_WORKER_OLLAMA_BASE_URL:-http://host.docker.internal:11434}
# Google's OpenAI-compatible endpoint + key for a gemini-* capture model. The
# worker calls Google DIRECTLY here (it can reach Google in <1s) rather than via
# the llm-router: POSTing to the router from the worker container hangs (the
# worker is on a different docker network — small GETs pass, POST bodies stall).
GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
MEMORY_CAPTURE_GEMINI_BASE_URL=${MEMORY_CAPTURE_GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta/openai}
MEMORY_CAPTURE_TIMEOUT_MS=${MEMORY_CAPTURE_TIMEOUT_MS:-30000}
CWENV_EOF
    chmod 600 "${CHAT_WORKER_DEST}/.env"

    if docker compose up -d --build --force-recreate; then
      report_progress 99 "chat_worker_ready" "chat-worker container started"
      log "chat-worker started"
    else
      log "WARN: chat-worker compose failed (chat features will be degraded)"
      report_progress 98 "chat_worker_compose_failed" "docker compose up failed"
    fi
  )
else
  log "No ${CHAT_WORKER_DEST}/docker-compose.yml and no source at ${CHAT_WORKER_SRC} — skipping chat-worker container (dashboard chat will not function until provisioned)"
fi

# ------------------------------------------------------------------
# AiFlow render service (headless Chromium) — per-tenant sidecar.
#
# ENTITLEMENT gate (keys on TIER, not VPS_SIZE): standard/enterprise get the
# sidecar, starter does not. This is a plan-feature decision — the June 2026
# KVM2 experiment validated that render runs fine on KVM2 hardware, so a
# standard tenant pinned to a kvm2 box still gets the sidecar. On starter we
# proactively tear any stale container down in case the tenant was downgraded.
#
# Same sync model as voice-bridge / chat-worker: rsync the staged repo source,
# rewrite .env every deploy (so AIFLOW_RENDER_TOKEN rotations land), and
# `--force-recreate` so a changed .env restarts the container. The Cloudflare
# Tunnel publishes it at render-${BUSINESS_ID}.<zone> → 127.0.0.1:8080.
# ------------------------------------------------------------------
AIFLOW_RENDER_SRC="${AIFLOW_RENDER_SRC:-/opt/newcoworker-repo/vps/aiflow-render}"
AIFLOW_RENDER_DEST="/opt/aiflow-render"

if [[ "${TIER}" == "starter" ]]; then
  if [[ -f "${AIFLOW_RENDER_DEST}/docker-compose.yml" ]]; then
    log "TIER=starter: tearing down aiflow-render (not included in the starter plan)..."
    ( cd "${AIFLOW_RENDER_DEST}" && docker compose down --remove-orphans ) || true
  else
    log "TIER=starter: skipping aiflow-render (not included in the starter plan)"
  fi
elif [[ -d "${AIFLOW_RENDER_SRC}" ]]; then
  log "Syncing aiflow-render source ${AIFLOW_RENDER_SRC} → ${AIFLOW_RENDER_DEST}..."
  mkdir -p "${AIFLOW_RENDER_DEST}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude ".env" \
      --exclude "node_modules" \
      "${AIFLOW_RENDER_SRC}/" "${AIFLOW_RENDER_DEST}/"
  else
    log "rsync not installed; falling back to cp -R (no --delete)"
    cp -R "${AIFLOW_RENDER_SRC}/." "${AIFLOW_RENDER_DEST}/"
  fi

  (
    cd "${AIFLOW_RENDER_DEST}"
    # AIFLOW_PLATFORM_URL / AIFLOW_GATEWAY_TOKEN reuse the platform origin +
    # shared gateway bearer the rest of the stack already uses for
    # /api/integrations/custom/* — the render service calls
    # /api/integrations/custom/credentials to fetch the tenant's stored login.
    cat > .env <<AIRENV_EOF
PORT=8080
AIFLOW_RENDER_TOKEN=${AIFLOW_RENDER_TOKEN:-}
AIFLOW_PLATFORM_URL=${APP_BASE_URL:-}
AIFLOW_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN:-}
AIRENV_EOF
    chmod 600 .env

    if docker compose up -d --build --force-recreate; then
      report_progress 99 "aiflow_render_ready" "aiflow-render container started"
      log "aiflow-render started"
    else
      log "WARN: aiflow-render compose failed (credentialed/SPA browse will be degraded)"
      report_progress 98 "aiflow_render_compose_failed" "docker compose up failed"
    fi
  )
else
  log "No aiflow-render source at ${AIFLOW_RENDER_SRC} — skipping render sidecar"
fi

log "=== Client deployment complete: ${BUSINESS_ID} ==="
