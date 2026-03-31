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
#   INWORLD_AGENT_ID         — inworld.ai agent ID for voice routing
#   INWORLD_API_KEY          — inworld.ai API key
#   LIGHTPANDA_WSS_URL       — Lightpanda browser endpoint

set -euo pipefail

TIER="${TIER:-standard}"
LOG="/var/log/deploy-client-${BUSINESS_ID:-unknown}.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

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

BUSINESS_NAME=$(echo "$IDENTITY_MD" | awk -F': ' '/^Business Name:/ {print $2; exit}')
OWNER_NAME=$(echo "$IDENTITY_MD" | awk -F': ' '/^Owner \/ Primary Contact:/ {print $2; exit}')

BUSINESS_SLUG=$(slugify "${BUSINESS_NAME:-business}")
OWNER_SLUG=$(slugify "${OWNER_NAME:-primary-contact}")

cat > "/opt/rowboat/memory/Organizations/${BUSINESS_SLUG}.md" <<EOF
# ${BUSINESS_NAME:-Business}

Seeded during New Coworker onboarding.

## Identity
$(printf '%s\n' "$IDENTITY_MD")
EOF

cat > "/opt/rowboat/memory/People/${OWNER_SLUG}.md" <<EOF
# ${OWNER_NAME:-Primary Contact}

## Relationship
- Primary contact for ${BUSINESS_NAME:-the business}

## Notes
- Seeded during New Coworker onboarding.
EOF

cat > /opt/rowboat/memory/Topics/assistant-operating-rules.md <<EOF
# Assistant Operating Rules

$(printf '%s\n' "$SOUL_MD")
EOF

cat > /opt/rowboat/memory/Topics/conversation-playbook.md <<EOF
# Conversation Playbook

$(printf '%s\n' "$MEMORY_MD")
EOF

cat > /opt/rowboat/memory/Projects/onboarding-bootstrap.md <<EOF
# Onboarding Bootstrap

- Business: ${BUSINESS_NAME:-Business}
- Seeded At: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
- Source: New Coworker onboarding chat
- Vault Files: soul.md, identity.md, memory.md
EOF

# ------------------------------------------------------------------
# 2. Write Rowboat .env with client-specific values
# ------------------------------------------------------------------
log "Writing Rowboat .env..."

# Tier-aware model selection
if [[ "$TIER" == "starter" ]]; then
  OLLAMA_MODEL="phi4-mini:3.8b"
else
  OLLAMA_MODEL="qwen3.5:7b"
fi

cat > /opt/rowboat/.env <<RENV_EOF
# Rowboat runtime configuration for business: ${BUSINESS_ID}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN}
BUSINESS_ID=${BUSINESS_ID}
TIER=${TIER}

# Ollama / LLM
PROVIDER_BASE_URL=http://localhost:11434
PROVIDER_API_KEY=ollama
PROVIDER_DEFAULT_MODEL=${OLLAMA_MODEL}
PROVIDER_COPILOT_MODEL=${OLLAMA_MODEL}

# inworld.ai voice (all tiers use mini)
INWORLD_API_KEY=${INWORLD_API_KEY:-}
INWORLD_AGENT_ID=${INWORLD_AGENT_ID:-}
INWORLD_TTS_MODEL=inworld-tts-1.5-mini

# Twilio
TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID:-}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN:-}
TWILIO_MESSAGING_SERVICE_SID=${TWILIO_MESSAGING_SERVICE_SID:-}

# Supabase notifications
NOTIFICATION_WEBHOOK=${SUPABASE_URL}/functions/v1/notifications
NOTIFICATION_WEBHOOK_TOKEN=${NOTIFICATIONS_WEBHOOK_TOKEN:-${SUPABASE_SERVICE_KEY}}

# Browser skills
LIGHTPANDA_WSS_URL=${LIGHTPANDA_WSS_URL:-wss://cdn.lightpanda.io/ws}

# Knowledge vault paths
ROWBOAT_VAULT_PATH=/opt/rowboat/vault
ROWBOAT_MEMORY_PATH=/opt/rowboat/memory
RENV_EOF

log "Rowboat .env written."

# ------------------------------------------------------------------
# 3. Restart Rowboat with new config
# ------------------------------------------------------------------
docker compose -f /opt/rowboat/docker-compose.yml restart rowboat || true
log "Rowboat restarted."

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

log "=== Client deployment complete: ${BUSINESS_ID} ==="
