#!/usr/bin/env bash
# deploy-client.sh — Provision a client-specific configuration on the VPS
# Called from the orchestration API after bootstrap.sh has run.
#
# Environment variables expected:
#   BUSINESS_ID         — UUID from Supabase
#   SUPABASE_URL        — Supabase project URL
#   SUPABASE_SERVICE_KEY — Service role key (write config back)
#   CLOUDFLARE_TUNNEL_TOKEN — cloudflared tunnel token
#   OPENCLAW_GATEWAY_TOKEN — shared bearer token for OpenClaw gateway auth
#   NOTIFICATIONS_WEBHOOK_TOKEN — token for Supabase Edge Function auth
#   ELEVENLABS_AGENT_ID — agent ID for voice routing

set -euo pipefail

LOG="/var/log/deploy-client-${BUSINESS_ID:-unknown}.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Deploying client: ${BUSINESS_ID} ==="

# ------------------------------------------------------------------
# 1. Write OpenClaw config from Supabase
# ------------------------------------------------------------------
log "Fetching business config from Supabase..."
CONFIG_JSON=$(curl -sf \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  "${SUPABASE_URL}/rest/v1/business_configs?business_id=eq.${BUSINESS_ID}&select=soul_md,identity_md,memory_md" \
  | jq -r '.[0]')

SOUL_MD=$(echo "$CONFIG_JSON" | jq -r '.soul_md // empty')
IDENTITY_MD=$(echo "$CONFIG_JSON" | jq -r '.identity_md // empty')

mkdir -p /opt/openclaw/config /opt/openclaw/memory

echo "$SOUL_MD" > /opt/openclaw/config/soul.md
echo "$IDENTITY_MD" > /opt/openclaw/config/identity.md

cat > /opt/openclaw/config/openclaw.json <<OPENCLAW_EOF
{
  "version": "1",
  "gateway_token": "${OPENCLAW_GATEWAY_TOKEN}",
  "features": {
    "chatCompletions": true,
    "losslessClaw": true,
    "browserSkills": true
  },
  "models": {
    "fast": "qwen3.5:4b",
    "balanced": "qwen3.5:7b",
    "deep": "llama4:9b"
  },
  "llm_router": "http://127.0.0.1:8080",
  "soul_path": "/etc/openclaw/soul.md",
  "identity_path": "/etc/openclaw/identity.md",
  "memory": {
    "provider": "lossless_claw",
    "path": "/var/openclaw/memory",
    "max_tokens": 8192
  },
  "browser": {
    "provider": "lightpanda",
    "endpoint": "${LIGHTPANDA_WSS_URL:-wss://cdn.lightpanda.io/ws}"
  },
  "notification_webhook": "${SUPABASE_URL}/functions/v1/notifications",
  "notification_webhook_token": "${NOTIFICATIONS_WEBHOOK_TOKEN:-${SUPABASE_SERVICE_ROLE_KEY}}",
  "compliance": {
    "fha_guardrails": true,
    "forbidden_topics": ["race", "religion", "national_origin", "familial_status", "disability", "sex", "color"]
  },
  "elevenlabs_agent_id": "${ELEVENLABS_AGENT_ID:-}"
}
OPENCLAW_EOF

log "OpenClaw config written."

# ------------------------------------------------------------------
# 2. Restart OpenClaw with new config
# ------------------------------------------------------------------
docker compose -f /opt/openclaw/docker-compose.yml restart openclaw-agent
log "OpenClaw restarted."

# ------------------------------------------------------------------
# 3. Set up cloudflared tunnel
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
# 4. Register VPS as online in Supabase
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
