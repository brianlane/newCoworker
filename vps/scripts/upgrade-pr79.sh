#!/usr/bin/env bash
# vps/scripts/upgrade-pr79.sh
#
# One-shot upgrade for VPSes provisioned BEFORE PR #79 (the move from
# in-Vercel chat streaming to a VPS-side chat-worker queue). For
# VPSes provisioned by the post-PR-#79 vps/scripts/deploy-client.sh
# this script is a no-op safe to skip — but it's also safe to re-run
# (idempotent) so a fleet-wide rollout can blast it to every box.
#
# Two changes this script applies:
#
#   (A) Rowboat .env hardening — removes OPENAI_API_KEY and adds
#       OPENAI_AGENTS_DISABLE_TRACING=1. The OpenAI Agents SDK that
#       Rowboat is built on auto-registers a tracing exporter against
#       platform.openai.com. With our placeholder OPENAI_API_KEY in
#       the env, every chat turn paid a [non-fatal] 401 round-trip
#       (~95s observed on srv1632631 before this fix). Removing the
#       key + disabling the exporter is what got cold-tenant first
#       turns down from 100s to <5s. See PR #79 conversation.
#
#   (B) Provisions /opt/chat-worker — rsyncs the worker source onto
#       the VPS, generates its .env (re-using values pulled from
#       /opt/rowboat/.env where possible), and brings up the
#       docker-compose stack on the rowboat_default network.
#
# Inputs (required on first run; safely re-readable from existing
# files on subsequent runs):
#
#   SUPABASE_URL              — full https URL of the Supabase project
#   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (worker bypasses RLS)
#   CHAT_WORKER_SRC           — path to vps/chat-worker on this VPS
#                               (default: /opt/newcoworker-repo/vps/chat-worker)
#
# Inputs read from /opt/rowboat/.env automatically:
#   BUSINESS_ID               — used as both the worker's BUSINESS_ID
#                               and ROWBOAT_PROJECT_ID
#   ROWBOAT_GATEWAY_TOKEN     — service-to-service auth for Rowboat
#
# Usage (typical):
#   scp vps/scripts/upgrade-pr79.sh root@<host>:/tmp/upgrade-pr79.sh
#   rsync -a vps/chat-worker/ root@<host>:/opt/newcoworker-repo/vps/chat-worker/
#   ssh root@<host> 'SUPABASE_URL=https://...supabase.co \
#                    SUPABASE_SERVICE_ROLE_KEY=eyJ... \
#                    bash /tmp/upgrade-pr79.sh'
#
# Exit codes:
#   0  success (or already-applied no-op)
#   1  configuration error (missing required env, /opt/rowboat not
#      present, etc.)
#   2  docker compose failed
#
# Verification after run:
#   docker logs chat-worker --tail 30
#   # expect "worker_start" + "realtime_status SUBSCRIBED"
#   curl -sS --max-time 5 http://localhost:3000/health
#   # expect HTTP 200 (rowboat still healthy after restart)

set -euo pipefail

log() { printf '[upgrade-pr79] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
  log "ERROR: must run as root (writes /opt/rowboat/.env, /opt/chat-worker/.env)"
  exit 1
fi

if [[ ! -d /opt/rowboat ]]; then
  log "ERROR: /opt/rowboat does not exist — this script is for VPSes already provisioned with Rowboat. Run vps/scripts/deploy-client.sh for a fresh provision."
  exit 1
fi

if [[ ! -f /opt/rowboat/.env ]]; then
  log "ERROR: /opt/rowboat/.env missing"
  exit 1
fi

CHAT_WORKER_SRC="${CHAT_WORKER_SRC:-/opt/newcoworker-repo/vps/chat-worker}"
CHAT_WORKER_DEST="/opt/chat-worker"

# ---------------------------------------------------------------------
# (A) Rowboat .env hardening (idempotent: every line is safe to re-apply)
# ---------------------------------------------------------------------
log "Hardening /opt/rowboat/.env..."

ROWBOAT_ENV=/opt/rowboat/.env

# Drop any existing OPENAI_API_KEY assignment (including blank values).
# Use a tmpfile + atomic mv so a crash mid-edit doesn't leave a
# half-written .env that prevents Rowboat from booting.
if grep -qE '^[[:space:]]*OPENAI_API_KEY=' "${ROWBOAT_ENV}"; then
  TMP_ENV=$(mktemp)
  grep -vE '^[[:space:]]*OPENAI_API_KEY=' "${ROWBOAT_ENV}" > "${TMP_ENV}"
  install -m 600 -o root -g root "${TMP_ENV}" "${ROWBOAT_ENV}"
  rm -f "${TMP_ENV}"
  log "  Removed OPENAI_API_KEY"
else
  log "  OPENAI_API_KEY already absent"
fi

# Append OPENAI_AGENTS_DISABLE_TRACING=1 only when missing — repeated
# `>>` would otherwise stack duplicate lines on every re-run.
if ! grep -qE '^[[:space:]]*OPENAI_AGENTS_DISABLE_TRACING=' "${ROWBOAT_ENV}"; then
  printf '\nOPENAI_AGENTS_DISABLE_TRACING=1\n' >> "${ROWBOAT_ENV}"
  log "  Added OPENAI_AGENTS_DISABLE_TRACING=1"
else
  log "  OPENAI_AGENTS_DISABLE_TRACING already set"
fi

# Restart Rowboat so the new env takes effect. `up -d` is a no-op when
# nothing changed; --force-recreate is what makes the container pick
# up the edited .env on subsequent runs.
log "Restarting rowboat container (--force-recreate)..."
if [[ -f /opt/rowboat/docker-compose.yml ]]; then
  ( cd /opt/rowboat && docker compose up -d --force-recreate rowboat ) || {
    log "ERROR: rowboat compose recreate failed"
    exit 2
  }
else
  log "WARN: /opt/rowboat/docker-compose.yml missing — skipping rowboat restart. Restart manually after this script finishes."
fi

# ---------------------------------------------------------------------
# (B) chat-worker provisioning
# ---------------------------------------------------------------------
log "Provisioning chat-worker at ${CHAT_WORKER_DEST}..."

# Source code: rsync from CHAT_WORKER_SRC if present, else require the
# caller to have already rsynced into CHAT_WORKER_DEST.
if [[ -d "${CHAT_WORKER_SRC}" && -f "${CHAT_WORKER_SRC}/docker-compose.yml" ]]; then
  log "  Syncing source ${CHAT_WORKER_SRC} → ${CHAT_WORKER_DEST}..."
  mkdir -p "${CHAT_WORKER_DEST}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude ".env" --exclude "node_modules" \
      "${CHAT_WORKER_SRC}/" "${CHAT_WORKER_DEST}/"
  else
    cp -R "${CHAT_WORKER_SRC}/." "${CHAT_WORKER_DEST}/"
  fi
elif [[ ! -f "${CHAT_WORKER_DEST}/docker-compose.yml" ]]; then
  log "ERROR: no chat-worker source at ${CHAT_WORKER_SRC} and no existing ${CHAT_WORKER_DEST}/docker-compose.yml. Rsync vps/chat-worker/ to one of those paths and re-run."
  exit 1
else
  log "  Using existing source at ${CHAT_WORKER_DEST}"
fi

# Required env. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY have no
# safe default — fail loudly if the caller forgot them.
: "${SUPABASE_URL:?SUPABASE_URL must be set in the environment}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be set in the environment}"

# Pull BUSINESS_ID + ROWBOAT_GATEWAY_TOKEN from the existing rowboat .env
# rather than asking the caller — eliminates a class of "deployed worker
# pointed at the wrong tenant" bugs.
BUSINESS_ID=$(grep -E '^[[:space:]]*BUSINESS_ID=' "${ROWBOAT_ENV}" | head -1 | cut -d= -f2- | tr -d '"' || true)
ROWBOAT_GATEWAY_TOKEN=$(grep -E '^[[:space:]]*ROWBOAT_GATEWAY_TOKEN=' "${ROWBOAT_ENV}" | head -1 | cut -d= -f2- | tr -d '"' || true)
if [[ -z "${BUSINESS_ID}" ]]; then
  log "ERROR: could not read BUSINESS_ID from ${ROWBOAT_ENV}"
  exit 1
fi
if [[ -z "${ROWBOAT_GATEWAY_TOKEN}" ]]; then
  log "ERROR: could not read ROWBOAT_GATEWAY_TOKEN from ${ROWBOAT_ENV}"
  exit 1
fi

# Worker .env. Re-written every run so service-key rotations land on
# the next upgrade-pr79.sh invocation without manual editing.
cat > "${CHAT_WORKER_DEST}/.env" <<CWENV_EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
ROWBOAT_BASE_URL=http://rowboat:3000
ROWBOAT_PROJECT_ID=${BUSINESS_ID}
ROWBOAT_GATEWAY_TOKEN=${ROWBOAT_GATEWAY_TOKEN}
BUSINESS_ID=${BUSINESS_ID}
CWENV_EOF
chmod 600 "${CHAT_WORKER_DEST}/.env"
log "  Wrote ${CHAT_WORKER_DEST}/.env"

log "  Bringing up chat-worker (--force-recreate)..."
( cd "${CHAT_WORKER_DEST}" && docker compose up -d --build --force-recreate ) || {
  log "ERROR: chat-worker compose up failed"
  exit 2
}

log "Done. Verify with:"
log "  docker logs chat-worker --tail 30"
log "  # expect 'worker_start' + 'realtime_status SUBSCRIBED'"
log "  curl -sS --max-time 5 -o /dev/null -w '%{http_code}\\n' http://localhost:3000/health"
log "  # expect 200"
