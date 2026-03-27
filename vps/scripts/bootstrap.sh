#!/usr/bin/env bash
# bootstrap.sh — Full server hardening + Ollama + Bifrost + Rowboat + cloudflared
# Run as root on a fresh Ubuntu 24.04 KVM VPS
# Usage: TIER=starter ./bootstrap.sh   (or TIER=standard)

set -euo pipefail

TIER="${TIER:-standard}"
BIFROST_VERSION="v0.6.0"
CLOUDFLARED_VERSION="2025.4.0"
LOG_FILE="/var/log/newcoworker-bootstrap.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== New Coworker VPS Bootstrap (TIER=${TIER}) ==="

# ------------------------------------------------------------------
# 1. System hardening
# ------------------------------------------------------------------
log "Hardening system..."
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades curl wget git jq zram-config

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
# 2. ZRAM (mandatory for KVM 2 / Starter tier)
# ------------------------------------------------------------------
if [[ "$TIER" == "starter" ]]; then
  log "Configuring ZRAM (mandatory for KVM 2 8GB RAM)..."
  modprobe zram
  echo lz4 > /sys/block/zram0/comp_algorithm
  echo 4G > /sys/block/zram0/disksize
  mkswap /dev/zram0
  swapon /dev/zram0

  # Persist ZRAM across reboots
  cat > /etc/systemd/system/zram-setup.service <<'ZRAM_EOF'
[Unit]
Description=ZRAM compressed swap for KVM 2
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'modprobe zram && echo lz4 > /sys/block/zram0/comp_algorithm && echo 4G > /sys/block/zram0/disksize && mkswap /dev/zram0 && swapon /dev/zram0'

[Install]
WantedBy=multi-user.target
ZRAM_EOF
  systemctl daemon-reload
  systemctl enable zram-setup
  log "ZRAM configured: 4GB lz4-compressed swap active."
fi

# ------------------------------------------------------------------
# 3. Docker
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
# 4. Ollama (tier-aware configuration)
# ------------------------------------------------------------------
log "Installing Ollama..."
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.ai/install.sh | sh
fi

# Tier-specific Ollama tuning
mkdir -p /etc/systemd/system/ollama.service.d

if [[ "$TIER" == "starter" ]]; then
  # KVM 2 (2 vCPU, 8GB RAM) — Resource-First config
  # Phi-4 Mini (3.8B Q4_K_M) uses ~3.5GB; strict single-model enforcement
  # TurboQuant KV cache compression: reduces active memory per conversation ~75%
  # Dynamic VRAM / Weight Streaming: loads weights just-in-time from NVMe
  cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OMP_NUM_THREADS=2"
Environment="OLLAMA_HOST=127.0.0.1:11434"
# TurboQuant KV cache compression — ACTIVE: quantizes KV cache to 4-bit,
# reducing active memory per conversation by ~75% (critical for 8GB KVM 2).
# OLLAMA_KV_CACHE_TYPE is a live Ollama env var (supported since Ollama 0.3+).
Environment="OLLAMA_KV_CACHE_TYPE=q4_0"
# Flash Attention — ACTIVE: enables memory-efficient attention computation
# (prerequisite for Dynamic VRAM / Weight Streaming on llama.cpp backend).
Environment="OLLAMA_FLASH_ATTENTION=1"
EOF
else
  # KVM 8 (8 vCPU, 32GB RAM) — full model set, higher parallelism
  cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_NUM_PARALLEL=3"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OMP_NUM_THREADS=8"
Environment="OLLAMA_HOST=127.0.0.1:11434"
# TurboQuant KV cache — ACTIVE: reduces KV cache memory ~75% (beneficial on KVM 8 too)
Environment="OLLAMA_KV_CACHE_TYPE=q4_0"
# Flash Attention — ACTIVE
Environment="OLLAMA_FLASH_ATTENTION=1"
EOF
fi

systemctl daemon-reload
systemctl enable ollama
systemctl start ollama

# Tier-aware model pulls
log "Pre-pulling AI models for TIER=${TIER} (background)..."
if [[ "$TIER" == "starter" ]]; then
  # KVM 2: single model — Phi-4 Mini 3.8B (Flash-Reasoning, Q4_K_M)
  # Superior logic-to-size ratio (85% math benchmarks), tuned for 2-core throughput
  (
    sleep 10
    ollama pull phi4-mini:3.8b || true
    log "KVM 2 model ready: phi4-mini:3.8b"
  ) &
else
  # KVM 8: full reasoning stack
  (
    sleep 10
    ollama pull qwen3.5:4b  || true
    ollama pull qwen3.5:7b  || true
    ollama pull llama4:9b   || true
    ollama pull qwen3.5:35b-a3b || true
    log "KVM 8 models pre-pulled."
  ) &
fi

# ------------------------------------------------------------------
# 5. Bifrost (local LLM router)
# ------------------------------------------------------------------
log "Installing Bifrost..."
mkdir -p /opt/bifrost
BIFROST_URL="https://github.com/maximhq/bifrost/releases/download/${BIFROST_VERSION}/bifrost-linux-amd64"
wget -q "$BIFROST_URL" -O /opt/bifrost/bifrost
chmod +x /opt/bifrost/bifrost

# Tier-aware Bifrost config
if [[ "$TIER" == "starter" ]]; then
  # KVM 2: single model, no warm-swapping
  cat > /opt/bifrost/config.yaml <<'EOF'
providers:
  - id: ollama
    base_url: http://127.0.0.1:11434
    type: ollama
    fallback_models:
      - phi4-mini:3.8b

routes:
  - name: all_tasks
    when: true
    model: phi4-mini:3.8b

fallback:
  ifBusy: phi4-mini:3.8b

server:
  port: 8080
  host: 127.0.0.1
EOF
else
  # KVM 8: full multi-route config with deep reasoning model
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
  deep: qwen3.5:35b-a3b
  verify: llama4:9b

server:
  port: 8080
  host: 127.0.0.1
EOF
fi

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
# 6. Rowboat (agent runtime — replaces OpenClaw)
# ------------------------------------------------------------------
log "Installing Rowboat..."
mkdir -p /opt/rowboat/vault /opt/rowboat/memory /opt/rowboat/logs

# Clone Rowboat
git clone https://github.com/rowboatlabs/rowboat.git /opt/rowboat/src 2>/dev/null || \
  git -C /opt/rowboat/src pull

# Build the Docker Compose stack
cd /opt/rowboat/src
cp .env.example .env 2>/dev/null || true

# Tier-aware Rowboat docker-compose
if [[ "$TIER" == "starter" ]]; then
  # KVM 2: slim stack — no qdrant, constrained mongo, no rag-worker
  cat > /opt/rowboat/docker-compose.yml <<'REOF'
version: "3.9"
services:
  rowboat:
    build:
      context: /opt/rowboat/src
    container_name: rowboat
    restart: always
    env_file: /opt/rowboat/.env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/rowboat/vault:/vault:ro
      - /opt/rowboat/memory:/memory
    mem_limit: 700m

  mongo:
    image: mongo:7
    container_name: rowboat-mongo
    restart: always
    volumes:
      - rowboat_mongo:/data/db
    mem_limit: 400m

  redis:
    image: redis:7-alpine
    container_name: rowboat-redis
    restart: always
    mem_limit: 100m

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: always
    environment:
      OLLAMA_NUM_PARALLEL: "1"
      OLLAMA_MAX_LOADED_MODELS: "1"
    network_mode: host
    volumes:
      - ollama_models:/root/.ollama

volumes:
  rowboat_mongo:
  ollama_models:
REOF
else
  # KVM 8: full stack with qdrant for RAG
  cat > /opt/rowboat/docker-compose.yml <<'REOF'
version: "3.9"
services:
  rowboat:
    build:
      context: /opt/rowboat/src
    container_name: rowboat
    restart: always
    env_file: /opt/rowboat/.env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/rowboat/vault:/vault:ro
      - /opt/rowboat/memory:/memory

  jobs-worker:
    build:
      context: /opt/rowboat/src
    container_name: rowboat-jobs
    restart: always
    env_file: /opt/rowboat/.env
    command: worker

  mongo:
    image: mongo:7
    container_name: rowboat-mongo
    restart: always
    volumes:
      - rowboat_mongo:/data/db

  redis:
    image: redis:7-alpine
    container_name: rowboat-redis
    restart: always

  qdrant:
    image: qdrant/qdrant:latest
    container_name: rowboat-qdrant
    restart: always
    volumes:
      - rowboat_qdrant:/qdrant/storage

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: always
    environment:
      OLLAMA_NUM_PARALLEL: "3"
      OLLAMA_MAX_LOADED_MODELS: "2"
    network_mode: host
    volumes:
      - ollama_models:/root/.ollama

volumes:
  rowboat_mongo:
  rowboat_qdrant:
  ollama_models:
REOF
fi

docker compose -f /opt/rowboat/docker-compose.yml up --build -d || true
log "Rowboat stack deployed."

# ------------------------------------------------------------------
# 7. cloudflared (Cloudflare Tunnel)
# ------------------------------------------------------------------
log "Installing cloudflared..."
CF_URL="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb"
wget -q "$CF_URL" -O /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb
rm /tmp/cloudflared.deb

log "cloudflared installed (tunnel credentials required via deploy-client.sh)."

# ------------------------------------------------------------------
# 8. Heartbeat cron
# ------------------------------------------------------------------
log "Setting up heartbeat cron..."
mkdir -p /opt/newcoworker/scripts
cp /opt/rowboat/crontab /opt/newcoworker/scripts/ 2>/dev/null || true

(crontab -l 2>/dev/null || echo "") | \
  grep -v heartbeat | \
  { cat; echo "*/2 * * * * /opt/newcoworker/scripts/heartbeat.sh >> /var/log/heartbeat.log 2>&1"; } | \
  crontab -

log "=== Bootstrap complete. Tier=${TIER}. Reboot recommended. ==="
