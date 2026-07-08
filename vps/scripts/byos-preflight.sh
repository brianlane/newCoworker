#!/usr/bin/env bash
# byos-preflight.sh — hard enrollment gate for customer-supplied (BYOS) boxes.
#
# Runs over SSH (as root) BEFORE bootstrap during BYOS enrollment
# (src/lib/provisioning/byos.ts stages it base64-encoded, like the
# orchestrator's bootstrap). A box hosting PII must start from a known-clean
# state, so any FAIL below aborts enrollment.
#
# Usage: VPS_SIZE=kvm8 bash byos-preflight.sh
#
# Output contract (parsed by parseByosPreflightOutput):
#   PREFLIGHT <check> <PASS|FAIL|WARN> <detail…>   one line per check
#   PREFLIGHT RESULT <PASS|FAIL>                   final verdict
# Exit code: 0 when no check FAILed, 1 otherwise. WARN never fails the
# script — disk encryption WARN is enforced app-side via the operator's
# provider-level-encryption attestation.

set -uo pipefail

VPS_SIZE="${VPS_SIZE:-kvm8}"
FAILED=0

report() {
  # $1 check name, $2 status, $3 detail
  echo "PREFLIGHT $1 $2 $3"
  if [[ "$2" == "FAIL" ]]; then FAILED=1; fi
}

# ------------------------------------------------------------------ os
# The whole fleet (bootstrap.sh, compose profiles, ZRAM handling) is built
# and tested against Ubuntu 24.04 — anything else is unsupported.
OS_ID="unknown"; OS_VERSION="unknown"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"; OS_VERSION="${VERSION_ID:-unknown}"
fi
if [[ "$OS_ID" == "ubuntu" && "$OS_VERSION" == "24.04" ]]; then
  report os PASS "ubuntu 24.04"
else
  report os FAIL "requires Ubuntu 24.04, found ${OS_ID} ${OS_VERSION}"
fi

# ------------------------------------------------------------------ hardware
# Minimums per hardware profile (matches src/lib/vps/size.ts semantics).
# RAM thresholds sit slightly under the nominal size because the kernel
# reserves memory (a 8GB box reports ~7.7GB MemTotal).
case "$VPS_SIZE" in
  kvm1) MIN_CPU=1; MIN_MEM_KB=3400000;  MIN_DISK_GB=40  ;;
  kvm2) MIN_CPU=2; MIN_MEM_KB=7000000;  MIN_DISK_GB=60  ;;
  kvm4) MIN_CPU=4; MIN_MEM_KB=14500000; MIN_DISK_GB=80  ;;
  *)    MIN_CPU=8; MIN_MEM_KB=29000000; MIN_DISK_GB=100 ;;
esac

CPUS="$(nproc 2>/dev/null || echo 0)"
if (( CPUS >= MIN_CPU )); then
  report cpu PASS "${CPUS} vCPU (min ${MIN_CPU} for ${VPS_SIZE})"
else
  report cpu FAIL "${CPUS} vCPU < required ${MIN_CPU} for ${VPS_SIZE}"
fi

MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if (( MEM_KB >= MIN_MEM_KB )); then
  report memory PASS "$(( MEM_KB / 1024 )) MiB (min $(( MIN_MEM_KB / 1024 )) for ${VPS_SIZE})"
else
  report memory FAIL "$(( MEM_KB / 1024 )) MiB < required $(( MIN_MEM_KB / 1024 )) MiB for ${VPS_SIZE}"
fi

DISK_GB="$(df -BG --output=size / 2>/dev/null | tail -1 | tr -dc '0-9')"
DISK_GB="${DISK_GB:-0}"
if (( DISK_GB >= MIN_DISK_GB )); then
  report disk PASS "${DISK_GB}G root filesystem (min ${MIN_DISK_GB}G for ${VPS_SIZE})"
else
  report disk FAIL "${DISK_GB}G root filesystem < required ${MIN_DISK_GB}G for ${VPS_SIZE}"
fi

# ------------------------------------------------------------------ co-tenancy
# A box holding one tenant's PII must run NOTHING else. Co-tenancy is an
# automatic fail: unexpected public listeners, running containers, or extra
# login-capable users all indicate the box is not fresh/dedicated.
PUBLIC_LISTENERS="$(ss -H -tlnp 2>/dev/null | awk '{print $4}' \
  | grep -Ev '^(127\.0\.0\.1|\[?::1\]?):' \
  | grep -Ev ':22$' | sort -u | tr '\n' ' ')"
if [[ -z "${PUBLIC_LISTENERS// /}" ]]; then
  report listeners PASS "only SSH (22) listening publicly"
else
  report listeners FAIL "unexpected public listeners: ${PUBLIC_LISTENERS}"
fi

if command -v docker >/dev/null 2>&1; then
  RUNNING="$(docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
  if [[ -z "${RUNNING// /}" ]]; then
    report containers PASS "no running containers"
  else
    report containers FAIL "running containers found: ${RUNNING}"
  fi
else
  report containers PASS "docker not installed yet (bootstrap installs it)"
fi

EXTRA_USERS="$(awk -F: '$3 >= 1000 && $1 != "nobody" && $7 !~ /(nologin|false)$/ {print $1}' /etc/passwd 2>/dev/null | tr '\n' ' ')"
if [[ -z "${EXTRA_USERS// /}" ]]; then
  report users PASS "no extra login-capable users"
else
  report users FAIL "unexpected login-capable users: ${EXTRA_USERS}"
fi

# ------------------------------------------------------------------ egress
# The box's entire public surface is an OUTBOUND cloudflared tunnel; without
# outbound 443 nothing works (tunnel, Supabase, Telnyx, model APIs).
if curl -sf --max-time 10 https://www.cloudflare.com/cdn-cgi/trace >/dev/null 2>&1; then
  report egress443 PASS "outbound 443 reachable (cloudflare trace)"
else
  report egress443 FAIL "outbound HTTPS (443) blocked — the Cloudflare tunnel cannot connect"
fi

# ------------------------------------------------------------------ disk encryption
# PII requirement: encryption at rest. dm-crypt/LUKS is detectable; provider-
# level (hypervisor/SAN) encryption is not — that case is a WARN and the
# enrollment flow requires an explicit operator attestation instead.
if lsblk -rno TYPE 2>/dev/null | grep -q '^crypt$'; then
  report disk_encryption PASS "dm-crypt/LUKS volume detected"
else
  report disk_encryption WARN "no dm-crypt/LUKS detected — provider-level encryption-at-rest attestation required"
fi

if (( FAILED == 0 )); then
  echo "PREFLIGHT RESULT PASS"
else
  echo "PREFLIGHT RESULT FAIL"
fi
exit "$FAILED"
