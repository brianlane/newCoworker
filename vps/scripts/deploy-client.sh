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
  "${SUPABASE_URL}/rest/v1/business_configs?business_id=eq.${BUSINESS_ID}&select=soul_md,identity_md,memory_md" \
  | jq -r '.[0]')

SOUL_MD=$(echo "$CONFIG_JSON" | jq -r '.soul_md // empty')
IDENTITY_MD=$(echo "$CONFIG_JSON" | jq -r '.identity_md // empty')
MEMORY_MD=$(echo "$CONFIG_JSON" | jq -r '.memory_md // empty')

slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

mkdir -p /opt/rowboat/vault /opt/rowboat/memory

echo "$SOUL_MD"     > /opt/rowboat/vault/soul.md
echo "$IDENTITY_MD" > /opt/rowboat/vault/identity.md
echo "$MEMORY_MD"   > /opt/rowboat/vault/memory.md

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

cat > /opt/rowboat/.env <<RENV_EOF
# Rowboat runtime configuration for business: ${BUSINESS_ID}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN}
BUSINESS_ID=${BUSINESS_ID}
TIER=${TIER}

# Ollama / LLM (host systemd — reachable from Rowboat container via Docker host-gateway)
PROVIDER_BASE_URL=http://host.docker.internal:11434/v1
PROVIDER_API_KEY=ollama
PROVIDER_DEFAULT_MODEL=${OLLAMA_MODEL}
PROVIDER_COPILOT_MODEL=${OLLAMA_MODEL}

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

log "Rowboat .env written."

report_progress 55 "env_written" "Rowboat .env written"

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
# 6. Voice bridge (optional): gold image may ship /opt/voice-bridge with docker-compose.yml
# ------------------------------------------------------------------
if [[ -f /opt/voice-bridge/docker-compose.yml ]]; then
  log "Starting voice-bridge from /opt/voice-bridge..."
  (
    cd /opt/voice-bridge
    if [[ ! -f .env ]]; then
      cat > .env <<VBENV_EOF
STREAM_URL_SIGNING_SECRET=${STREAM_URL_SIGNING_SECRET:-}
SUPABASE_URL=${SUPABASE_URL:-}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_KEY:-}
BUSINESS_ID=${BUSINESS_ID:-}
BRIDGE_MEDIA_WSS_ORIGIN=${BRIDGE_MEDIA_WSS_ORIGIN:-}
GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
GEMINI_LIVE_MODEL=${GEMINI_LIVE_MODEL:-gemini-3.1-flash-live-preview}
VBENV_EOF
    fi
    docker compose up -d --build || log "WARN: voice-bridge compose failed"
  )
else
  log "No /opt/voice-bridge/docker-compose.yml — skipping voice bridge container"
fi

log "=== Client deployment complete: ${BUSINESS_ID} ==="
