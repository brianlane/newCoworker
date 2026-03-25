#!/usr/bin/env bash
# bootstrap.sh — Full server hardening + Ollama + Bifrost + OpenClaw + cloudflared
# Run as root on a fresh Ubuntu 22.04 KVM VPS

set -euo pipefail

BIFROST_VERSION="v0.6.0"
OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
CLOUDFLARED_VERSION="2025.4.0"
LOG_FILE="/var/log/newcoworker-bootstrap.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== New Coworker VPS Bootstrap ==="

# ------------------------------------------------------------------
# 1. System hardening
# ------------------------------------------------------------------
log "Hardening system..."
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades curl wget git jq

# UFW firewall — only allow SSH, HTTP, HTTPS
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw --force enable

# fail2ban — block brute-force SSH
systemctl enable fail2ban
systemctl start fail2ban

# Automatic security updates
dpkg-reconfigure -plow unattended-upgrades > /dev/null 2>&1

log "System hardening complete."

# ------------------------------------------------------------------
# 2. Docker
# ------------------------------------------------------------------
log "Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu 2>/dev/null || true
log "Docker installed."

# ------------------------------------------------------------------
# 3. Ollama
# ------------------------------------------------------------------
log "Installing Ollama..."
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.ai/install.sh | sh
fi

# Ollama performance tuning
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_NUM_PARALLEL=3"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OMP_NUM_THREADS=8"
Environment="OLLAMA_HOST=127.0.0.1:11434"
EOF
systemctl daemon-reload
systemctl enable ollama
systemctl start ollama

# Pull models (background)
log "Pre-pulling AI models (background)..."
(
  sleep 10
  ollama pull qwen3.5:4b  || true
  ollama pull qwen3.5:7b  || true
  ollama pull llama4:9b   || true
  log "Models pre-pulled."
) &

# ------------------------------------------------------------------
# 4. Bifrost (local LLM router)
# ------------------------------------------------------------------
log "Installing Bifrost..."
mkdir -p /opt/bifrost
BIFROST_URL="https://github.com/maximhq/bifrost/releases/download/${BIFROST_VERSION}/bifrost-linux-amd64"
wget -q "$BIFROST_URL" -O /opt/bifrost/bifrost
chmod +x /opt/bifrost/bifrost

# Bifrost config
cat > /opt/bifrost/config.yaml <<'EOF'
providers:
  - id: ollama
    base_url: http://127.0.0.1:11434
    type: ollama
    fallback_models:
      - qwen3.5:4b
      - qwen3.5:7b
      - llama4:9b

routing:
  fast: qwen3.5:4b
  balanced: qwen3.5:7b
  deep: llama4:9b

server:
  port: 8080
  host: 127.0.0.1
EOF

cat > /etc/systemd/system/bifrost.service <<'EOF'
[Unit]
Description=Bifrost LLM Router
After=network.target ollama.service

[Service]
ExecStart=/opt/bifrost/bifrost --config /opt/bifrost/config.yaml
Restart=always
RestartSec=5
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bifrost
systemctl start bifrost
log "Bifrost installed and running."

# ------------------------------------------------------------------
# 5. OpenClaw (agent runtime)
# ------------------------------------------------------------------
log "Installing OpenClaw..."
mkdir -p /opt/openclaw/config /opt/openclaw/logs /opt/openclaw/memory

cat > /opt/openclaw/docker-compose.yml <<'EOF'
version: "3.9"
services:
  openclaw-agent:
    image: ghcr.io/openclaw/openclaw:latest
    restart: always
    environment:
      - OPENCLAW_CONFIG=/etc/openclaw/openclaw.json
      - OPENCLAW_LOG_DIR=/var/log/openclaw
    volumes:
      - /opt/openclaw/config:/etc/openclaw:ro
      - /opt/openclaw/logs:/var/log/openclaw
      - /opt/openclaw/memory:/var/openclaw/memory
    ports:
      - "127.0.0.1:3000:3000"
    network_mode: bridge
EOF

docker pull "$OPENCLAW_IMAGE" || true
docker compose -f /opt/openclaw/docker-compose.yml up -d || true
log "OpenClaw deployed."

# ------------------------------------------------------------------
# 6. cloudflared (Cloudflare Tunnel)
# ------------------------------------------------------------------
log "Installing cloudflared..."
CF_URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb"
wget -q "$CF_URL" -O /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb
rm /tmp/cloudflared.deb

# Tunnel service will be configured by deploy-client.sh with actual credentials
log "cloudflared installed (tunnel credentials required via deploy-client.sh)."

# ------------------------------------------------------------------
# 7. Heartbeat cron
# ------------------------------------------------------------------
log "Setting up heartbeat cron..."
mkdir -p /opt/newcoworker/scripts
cp /opt/openclaw/heartbeat.sh /opt/newcoworker/scripts/heartbeat.sh 2>/dev/null || true

(crontab -l 2>/dev/null || echo "") | \
  grep -v heartbeat | \
  { cat; echo "*/2 * * * * /opt/newcoworker/scripts/heartbeat.sh >> /var/log/heartbeat.log 2>&1"; } | \
  crontab -

log "=== Bootstrap complete. Reboot recommended. ==="
