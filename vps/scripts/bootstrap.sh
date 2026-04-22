#!/usr/bin/env bash
# bootstrap.sh — Full server hardening + Ollama + Rowboat + cloudflared
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
  # Llama 3.2 3B (~2 GiB typical in Ollama); strict single-model enforcement
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
  # KVM 2: single model — Llama 3.2 3B (standard tier KVM8 uses qwen3:4b-instruct)
  (
    sleep 10
    ollama pull llama3.2:3b || true
    log "KVM 2 model ready: llama3.2:3b"
  ) &
else
  # KVM 8 (CPU): primary **`qwen3:4b-instruct`** for Rowboat → Ollama; optional larger tags for experiments / GPU.
  (
    sleep 10
    ollama pull qwen3:4b-instruct || true
    ollama pull llama4:9b   || true
    ollama pull qwen3.5:35b-a3b || true
    log "KVM 8 models pre-pulled (primary: qwen3:4b-instruct)."
  ) &
fi

# ------------------------------------------------------------------
# 5. LLM path: Rowboat → Ollama only (no Bifrost). Remove legacy Bifrost container if present.
# ------------------------------------------------------------------
systemctl disable --now bifrost 2>/dev/null || true
rm -f /etc/systemd/system/bifrost.service
systemctl daemon-reload 2>/dev/null || true
docker rm -f bifrost 2>/dev/null || true
rm -rf /opt/bifrost 2>/dev/null || true
log "LLM traffic: Rowboat uses PROVIDER_BASE_URL → host Ollama OpenAI API (http://127.0.0.1:11434/v1)."

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

# Stage the llm-router source from the checked-out repo so the compose
# `build:` directive below can reuse the same Dockerfile across tiers.
#
# We tolerate a missing source tree for air-gapped recovery reboots: the
# router service stays in compose either way, and bootstrap's
# `docker compose up` will surface a build failure loudly. deploy-client.sh
# re-runs compose on every deploy and so will recover once the repo appears.
LLM_ROUTER_SRC="${LLM_ROUTER_SRC:-/opt/newcoworker-repo/vps/llm-router}"
LLM_ROUTER_DEST="/opt/rowboat/llm-router"
if [[ -d "${LLM_ROUTER_SRC}" ]]; then
  mkdir -p "${LLM_ROUTER_DEST}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude "node_modules" \
      "${LLM_ROUTER_SRC}/" "${LLM_ROUTER_DEST}/"
  else
    cp -R "${LLM_ROUTER_SRC}/." "${LLM_ROUTER_DEST}/"
  fi
  log "llm-router source staged at ${LLM_ROUTER_DEST}"
else
  log "WARN: llm-router source not found at ${LLM_ROUTER_SRC}; compose build will fail until repo is staged"
fi

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
    depends_on:
      - llm-router

  llm-router:
    build:
      context: /opt/rowboat/llm-router
    container_name: llm-router
    restart: always
    env_file: /opt/rowboat/.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      # Ollama runs on the host via systemd; route traffic back out through
      # the docker host-gateway so the container can reach 127.0.0.1:11434.
      OLLAMA_URL: http://host.docker.internal:11434
      LLM_ROUTER_PORT: 11435
    ports:
      - "127.0.0.1:11435:11435"
    mem_limit: 128m

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

# Ollama: host systemd only (§4). Rowboat routes LLM traffic through the
# llm-router sidecar (PROVIDER_BASE_URL=http://llm-router:11435/v1) which
# forwards llama*/qwen* to Ollama and gemini-* to Google.

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
    depends_on:
      - llm-router

  llm-router:
    build:
      context: /opt/rowboat/llm-router
    container_name: llm-router
    restart: always
    env_file: /opt/rowboat/.env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      OLLAMA_URL: http://host.docker.internal:11434
      LLM_ROUTER_PORT: 11435
    ports:
      - "127.0.0.1:11435:11435"

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

# Ollama: host systemd only (§4). Rowboat / jobs-worker route LLM traffic
# through the llm-router sidecar (PROVIDER_BASE_URL=http://llm-router:11435/v1).

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
# 7b. Stage newCoworker repo for voice-bridge source sync
#
# `deploy-client.sh` reads the voice-bridge source from
# ${VOICE_BRIDGE_SRC:-/opt/newcoworker-repo/vps/voice-bridge} on every deploy
# (see §6 of that script). Clone a shallow copy here so the first deploy for
# this VPS has a source to rsync from. Operators can override the default
# path by exporting VOICE_BRIDGE_SRC from the orchestrator, but the 90% case
# is "public repo checked out at the canonical path" and we handle it here.
#
# Overridable via env for forks / private mirrors:
#   NEWCOWORKER_REPO_URL    — git URL (default: public OSS repo)
#   NEWCOWORKER_REPO_REF    — branch/tag/sha to check out (default: main)
#   NEWCOWORKER_REPO_PATH   — filesystem destination (default: /opt/newcoworker-repo)
# ------------------------------------------------------------------
NEWCOWORKER_REPO_URL="${NEWCOWORKER_REPO_URL:-https://github.com/brianlane/newCoworker.git}"
NEWCOWORKER_REPO_REF="${NEWCOWORKER_REPO_REF:-main}"
NEWCOWORKER_REPO_PATH="${NEWCOWORKER_REPO_PATH:-/opt/newcoworker-repo}"

log "Staging newCoworker repo at ${NEWCOWORKER_REPO_PATH} (ref=${NEWCOWORKER_REPO_REF})..."
mkdir -p "$(dirname "${NEWCOWORKER_REPO_PATH}")"
if [[ -d "${NEWCOWORKER_REPO_PATH}/.git" ]]; then
  # Idempotent re-bootstrap: fast-forward the existing checkout instead of
  # re-cloning. This keeps any local hooks and avoids re-downloading the pack.
  git -C "${NEWCOWORKER_REPO_PATH}" fetch --depth=1 origin "${NEWCOWORKER_REPO_REF}" || true
  git -C "${NEWCOWORKER_REPO_PATH}" checkout -B "${NEWCOWORKER_REPO_REF}" \
      "origin/${NEWCOWORKER_REPO_REF}" || true
else
  # `--depth=1 --branch` is much faster and avoids ~100 MB of history we never
  # need on a VPS. The repo is currently public; if it becomes private, replace
  # the URL with an HTTPS+token or a deploy-key SSH variant via the env overrides
  # above — no code changes required here.
  git clone --depth=1 --branch "${NEWCOWORKER_REPO_REF}" \
    "${NEWCOWORKER_REPO_URL}" "${NEWCOWORKER_REPO_PATH}" || \
    log "WARN: git clone ${NEWCOWORKER_REPO_URL} failed; voice-bridge source will be missing until deploy-client.sh re-syncs."
fi

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
