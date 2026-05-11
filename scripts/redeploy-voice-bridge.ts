#!/usr/bin/env tsx
/**
 * Targeted voice-bridge redeploy across every per-tenant VPS.
 *
 * Why this exists:
 *   `vps/scripts/deploy-client.sh` is the full provisioner — it rewrites
 *   `/opt/voice-bridge/.env`, reseeds Rowboat's Mongo agent prompts,
 *   re-stages bootstrap deps, and runs every health gate. Re-running
 *   that entire pipeline just to ship a bridge-only code change (e.g.
 *   the Phase 3b customer-memory tool wiring) is overkill and risks
 *   regressing unrelated phases (.env writes, Mongo re-seed) for a
 *   change that touches nothing outside `vps/voice-bridge/`.
 *
 *   This script does the minimum needed to roll a new bridge image:
 *     1. SSH into the live VPS
 *     2. `git fetch && git checkout` the requested ref in
 *        `/opt/newcoworker-repo`
 *     3. rsync `vps/voice-bridge/` → `/opt/voice-bridge/` while
 *        preserving `.env`, `node_modules`, `dist` (matches the rsync
 *        excludes in `deploy-client.sh`)
 *     4. `docker compose up -d --build --force-recreate` in
 *        `/opt/voice-bridge`
 *     5. Poll `http://127.0.0.1:8090/` until 200 (or 40s timeout)
 *
 *   `.env`, vault markdown, Rowboat Mongo, llm-router, and Cloudflare
 *   tunnel state are all left exactly as they were. For a **full**
 *   `deploy-client.sh` run (Mongo workflow re-seed, chat-worker, vault,
 *   etc.), use `scripts/redeploy-deploy-client.ts`. For vault-only edits
 *   use `syncVaultToVps` (src/lib/vps/sync-vault.ts); for buying a fresh
 *   VM use the orchestrator.
 *
 * Usage:
 *   npx tsx scripts/redeploy-voice-bridge.ts                       # all tenant VPSes, ref=main
 *   npx tsx scripts/redeploy-voice-bridge.ts --ref polish          # roll a feature branch
 *   npx tsx scripts/redeploy-voice-bridge.ts --business <uuid>     # single tenant
 *   npx tsx scripts/redeploy-voice-bridge.ts --json                # machine-readable output
 *
 * Required env (caller must export or pre-load `.env`, e.g.
 * `set -a; source .env; set +a; npx tsx scripts/redeploy-voice-bridge.ts`):
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL as alias), SUPABASE_SERVICE_ROLE_KEY
 *   HOSTINGER_API_TOKEN                        — resolve VPS public IP
 *
 * Exit codes:
 *   0  — every targeted VPS reported `voice_bridge_ready`
 *   1  — one or more tenants failed (see `failures` in JSON output)
 *   2  — bad CLI args or missing env
 */
import { getActiveVpsSshKeyForBusiness } from "@/lib/db/vps-ssh-keys";
import { sshExec } from "@/lib/hostinger/ssh";
import {
  assertSafeGitRef,
  listTenantVpsTargets,
  parseTenantVpsRedeployArgs,
  resolveTenantVpsPublicIp,
  requireServiceRoleAndHostingerToken,
  ensureNextPublicSupabaseUrlOrExit,
  type TenantVpsRedeployResult,
  type TenantVpsTarget
} from "./lib/redeploy-tenant-vps";

/**
 * The exact bash run over SSH. Mirrors the bridge sync block of
 * `deploy-client.sh` (lines ~584-776) minus the .env rewrite — this
 * helper deliberately doesn't touch /opt/voice-bridge/.env so secret
 * rotations stay confined to the full deploy path.
 */
function buildBridgeRedeployCommand(ref: string): string {
  assertSafeGitRef(ref);
  return `set -euo pipefail
NEWCOWORKER_REPO_PATH="/opt/newcoworker-repo"
NEWCOWORKER_REPO_REF='${ref}'
NEWCOWORKER_REPO_URL="https://github.com/brianlane/newCoworker.git"
VOICE_BRIDGE_SRC="\${NEWCOWORKER_REPO_PATH}/vps/voice-bridge"
VOICE_BRIDGE_DEST="/opt/voice-bridge"

echo "[redeploy-bridge] refreshing repo at \${NEWCOWORKER_REPO_PATH} (ref=\${NEWCOWORKER_REPO_REF})"
if [[ -d "\${NEWCOWORKER_REPO_PATH}/.git" ]]; then
  git -C "\${NEWCOWORKER_REPO_PATH}" fetch --depth=1 origin "\${NEWCOWORKER_REPO_REF}"
  git -C "\${NEWCOWORKER_REPO_PATH}" checkout -B "\${NEWCOWORKER_REPO_REF}" "origin/\${NEWCOWORKER_REPO_REF}"
elif command -v git >/dev/null 2>&1; then
  mkdir -p "$(dirname "\${NEWCOWORKER_REPO_PATH}")"
  git clone --depth=1 --branch "\${NEWCOWORKER_REPO_REF}" "\${NEWCOWORKER_REPO_URL}" "\${NEWCOWORKER_REPO_PATH}"
else
  echo "git not installed" >&2
  exit 1
fi

if [[ ! -d "\${VOICE_BRIDGE_SRC}" || ! -f "\${VOICE_BRIDGE_SRC}/docker-compose.yml" ]]; then
  echo "missing bridge source at \${VOICE_BRIDGE_SRC}" >&2
  exit 1
fi

echo "[redeploy-bridge] rsync \${VOICE_BRIDGE_SRC} -> \${VOICE_BRIDGE_DEST}"
mkdir -p "\${VOICE_BRIDGE_DEST}"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \\
    --exclude ".env" \\
    --exclude "node_modules" \\
    --exclude "dist" \\
    "\${VOICE_BRIDGE_SRC}/" "\${VOICE_BRIDGE_DEST}/"
else
  cp -R "\${VOICE_BRIDGE_SRC}/." "\${VOICE_BRIDGE_DEST}/"
fi

echo "[redeploy-bridge] docker compose up -d --build --force-recreate"
cd "\${VOICE_BRIDGE_DEST}"
docker compose up -d --build --force-recreate

echo "[redeploy-bridge] polling http://127.0.0.1:8090/ (40s budget)"
for _ in $(seq 1 20); do
  if curl -sf --max-time 3 http://127.0.0.1:8090/ >/dev/null 2>&1; then
    echo "[redeploy-bridge] voice_bridge_ready"
    exit 0
  fi
  sleep 2
done
echo "[redeploy-bridge] voice_bridge_unhealthy: never returned 200 within 40s" >&2
exit 1
`;
}

async function redeployOne(target: TenantVpsTarget, ref: string, hostingerToken: string): Promise<TenantVpsRedeployResult> {
  const key = await getActiveVpsSshKeyForBusiness(target.businessId);
  if (!key) {
    return { ...target, ok: false, detail: "no_active_ssh_key" };
  }
  const publicIp = await resolveTenantVpsPublicIp(target.hostingerVpsId, hostingerToken, "[redeploy-bridge]");
  if (!publicIp) {
    return { ...target, ok: false, detail: "no_public_ip" };
  }
  const command = buildBridgeRedeployCommand(ref);
  try {
    const result = await sshExec({
      host: publicIp,
      port: 22,
      username: key.ssh_username,
      privateKeyPem: key.private_key_pem,
      command,
      timeoutMs: 300_000
    });
    const stdoutTail = (result.stdout || "").split("\n").slice(-15).join("\n");
    if (result.exitCode === 0) {
      return { ...target, ok: true, publicIp, exitCode: 0, stdoutTail };
    }
    return {
      ...target,
      ok: false,
      publicIp,
      exitCode: result.exitCode,
      detail: `ssh exit ${result.exitCode}`,
      stdoutTail: `${stdoutTail}\n--stderr--\n${(result.stderr || "").slice(-800)}`
    };
  } catch (err) {
    return {
      ...target,
      ok: false,
      publicIp,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

async function main(): Promise<void> {
  const args = parseTenantVpsRedeployArgs(
    process.argv.slice(2),
    "Usage: tsx scripts/redeploy-voice-bridge.ts [--ref main] [--business <uuid>] [--json]\n"
  );
  ensureNextPublicSupabaseUrlOrExit();
  const hostingerToken = requireServiceRoleAndHostingerToken();

  const targets = await listTenantVpsTargets(args.businessId);
  if (targets.length === 0) {
    process.stdout.write(
      args.businessId
        ? `no per-tenant VPS for business ${args.businessId}\n`
        : "no per-tenant VPSes provisioned\n"
    );
    process.exit(0);
  }

  const results: TenantVpsRedeployResult[] = [];
  for (const t of targets) {
    process.stderr.write(`\n=== ${t.businessId} (vps=${t.hostingerVpsId}) ===\n`);
    const r = await redeployOne(t, args.ref, hostingerToken);
    results.push(r);
    if (args.json) continue;
    if (r.ok) {
      process.stdout.write(`OK  ${t.businessId} (ip=${r.publicIp}) ref=${args.ref}\n`);
    } else {
      process.stdout.write(`FAIL ${t.businessId} ip=${r.publicIp ?? "?"} detail=${r.detail ?? ""}\n`);
    }
    if (r.stdoutTail) process.stderr.write(r.stdoutTail + "\n");
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ref: args.ref, results }, null, 2) + "\n");
  }

  const failures = results.filter((r) => !r.ok);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
