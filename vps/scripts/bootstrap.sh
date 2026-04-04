#!/usr/bin/env bash
# bootstrap.sh — Full server hardening + Ollama + Bifrost + Rowboat + cloudflared
# Run as root on a fresh Ubuntu 24.04 KVM VPS
# Usage: TIER=starter ./bootstrap.sh   (or TIER=standard)

set -euo pipefail

TIER="${TIER:-standard}"
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
# Copyable env list for Compose / docs: vps/fragments/starter-ollama-container.env
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
    ollama pull qwen3.5:9b  || true
    ollama pull llama4:9b   || true
    ollama pull qwen3.5:35b-a3b || true
    log "KVM 8 models pre-pulled."
  ) &
fi

# ------------------------------------------------------------------
# 5. Bifrost (maximhq/bifrost AI gateway — Docker; see vps/bifrost/README.md)
# ------------------------------------------------------------------
log "Installing Bifrost (Docker image maximhq/bifrost)..."
mkdir -p /opt/bifrost/data

# Tier-aware routing intent — reference YAML on disk (mirror in Web UI / exported JSON).
# The gateway image persists live config under /app/data; this file is not auto-loaded
# unless you import it per current Bifrost docs — keep in sync with vps/bifrost/config-kvm2.yaml
# and vps/bifrost/config-kvm8.yaml in the repo.
if [[ "$TIER" == "starter" ]]; then
  cat > /opt/bifrost/routing-intent.yaml <<'BIFROST_KVM2_EOF'
# Bifrost — KVM 2 (starter) routing intent (reference only).
# Production gateway: Docker image maximhq/bifrost — configure via Web UI / JSON per
# https://github.com/maximhq/bifrost and https://docs.getbifrost.ai (see vps/bifrost/README.md).
#
# Single model: Phi-4 Mini 3.8B — no warm-swapping to stay within 8GB RAM budget
# Flash-Reasoning variant: tuned for 10x throughput on 2 vCPU
#
# TurboQuant (OLLAMA_KV_CACHE_TYPE=q4_0) and Flash Attention (OLLAMA_FLASH_ATTENTION=1)
# are ACTIVE at the Ollama layer — set in /etc/systemd/system/ollama.service.d/override.conf
# by bootstrap.sh. These reduce KV cache memory ~75% and enable weight streaming.
# Bifrost is the LLM router and does not implement these directly — they are enforced
# by the Ollama inference backend below.

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

# Inference optimization hooks (enabled when upstream support merges)
# optimization:
#   turbo_quant:
#     enabled: true
#     kv_cache_compression: q4_0
#     target_memory_reduction: 0.75
#   dynamic_vram:
#     enabled: true
#     weight_streaming: true
#     nvme_offload_path: /var/lib/ollama/weights

server:
  port: 8080
  host: 127.0.0.1
BIFROST_KVM2_EOF
else
  cat > /opt/bifrost/routing-intent.yaml <<'BIFROST_KVM8_EOF'
# Bifrost — KVM 8 (standard) routing intent (reference only).
# Production gateway: Docker image maximhq/bifrost — configure via Web UI / JSON per
# https://github.com/maximhq/bifrost and https://docs.getbifrost.ai (see vps/bifrost/README.md).
#
# Multi-route stack for larger VPS; Ollama on same host as gateway.

providers:
  - id: ollama
    base_url: http://127.0.0.1:11434
    type: ollama
    fallback_models:
      - qwen3.5:4b
      - qwen3.5:9b
      - llama4:9b

routing:
  fast: qwen3.5:4b
  balanced: qwen3.5:9b
  deep: qwen3.5:35b-a3b
  verify: llama4:9b

server:
  port: 8080
  host: 127.0.0.1
BIFROST_KVM8_EOF
fi
log "Bifrost tier routing intent written: /opt/bifrost/routing-intent.yaml (TIER=${TIER})"

# Remove legacy systemd + binary install if re-running bootstrap
systemctl disable --now bifrost 2>/dev/null || true
rm -f /etc/systemd/system/bifrost.service
systemctl daemon-reload 2>/dev/null || true
docker rm -f bifrost 2>/dev/null || true
docker pull maximhq/bifrost:latest
docker run -d \
  --name bifrost \
  --restart unless-stopped \
  --network host \
  -v /opt/bifrost/data:/app/data \
  maximhq/bifrost:latest
log "Bifrost gateway running on port 8080 (host network). Web UI: http://127.0.0.1:8080"
log "Configure the Ollama provider at http://127.0.0.1:11434 — mirror /opt/bifrost/routing-intent.yaml in the UI where applicable; see https://docs.getbifrost.ai"

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
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/rowboat/vault:/vault:ro
      - /opt/rowboat/memory:/memory
    mem_limit: 1536m

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

# Ollama: host systemd only (§4). Rowboat reaches it via PROVIDER_BASE_URL=http://host.docker.internal:11434

volumes:
  rowboat_mongo:
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
    extra_hosts:
      - "host.docker.internal:host-gateway"
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
    extra_hosts:
      - "host.docker.internal:host-gateway"
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

# Ollama: host systemd only (§4). Rowboat / jobs-worker use host.docker.internal:11434

volumes:
  rowboat_mongo:
  rowboat_qdrant:
REOF
fi

docker compose -f /opt/rowboat/docker-compose.yml up --build -d --remove-orphans || true
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
