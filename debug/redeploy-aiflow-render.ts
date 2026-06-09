#!/usr/bin/env tsx
/**
 * Targeted aiflow-render redeploy across per-tenant VPSes.
 *
 * Why this exists (same rationale as `redeploy-voice-bridge.ts`):
 *   `vps/scripts/deploy-client.sh` is the full provisioner — it rewrites
 *   `/opt/aiflow-render/.env` from the RUNNER's process env, reseeds Rowboat
 *   Mongo, rewrites vault, etc. Re-running all of that just to roll a
 *   render-service code change (e.g. screenshot capture) is overkill and, if
 *   the runner is missing a secret like AIFLOW_RENDER_TOKEN, would blank it
 *   on the VPS. This script does the minimum:
 *     1. SSH into the live VPS
 *     2. `git fetch && git checkout` the requested ref in /opt/newcoworker-repo
 *     3. rsync `vps/aiflow-render/` → `/opt/aiflow-render/` preserving `.env`
 *        and `node_modules` (matches deploy-client.sh's excludes)
 *     4. `docker compose up -d --build --force-recreate`
 *     5. Poll `http://127.0.0.1:8080/health` until 200 (60s budget — the
 *        image build pulls Playwright layers, the poll only starts after)
 *
 *   Starter-tier tenants are skipped: the render sidecar is not deployed on
 *   KVM2 (deploy-client.sh tears it down there).
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/redeploy-aiflow-render.ts                   # all render-capable tenants
 *   tsx debug/redeploy-aiflow-render.ts --ref main
 *   tsx debug/redeploy-aiflow-render.ts --business <uuid> # single tenant
 *   tsx debug/redeploy-aiflow-render.ts --json
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 * HOSTINGER_API_TOKEN.
 *
 * Exit codes: 0 all ok; 1 any failure; 2 bad args/env.
 */
import { loadEnv } from "./_shared.ts";
import { getActiveVpsSshKeyForBusiness } from "../src/lib/db/vps-ssh-keys.ts";
import { sshExec } from "../src/lib/hostinger/ssh.ts";
import {
  assertSafeGitRef,
  listTenantVpsTargets,
  parseTenantVpsRedeployArgs,
  resolveTenantVpsPublicIp,
  requireServiceRoleAndHostingerToken,
  ensureNextPublicSupabaseUrlOrExit,
  type TenantVpsRedeployResult,
  type TenantVpsTarget
} from "../scripts/lib/redeploy-tenant-vps.ts";

/**
 * The exact bash run over SSH. Mirrors the aiflow-render block of
 * `deploy-client.sh` (lines ~1142-1202) minus the .env rewrite — secret
 * rotations stay confined to the full deploy path.
 */
function buildRenderRedeployCommand(ref: string): string {
  assertSafeGitRef(ref);
  return `set -euo pipefail
NEWCOWORKER_REPO_PATH="/opt/newcoworker-repo"
NEWCOWORKER_REPO_REF='${ref}'
NEWCOWORKER_REPO_URL="https://github.com/brianlane/newCoworker.git"
AIFLOW_RENDER_SRC="\${NEWCOWORKER_REPO_PATH}/vps/aiflow-render"
AIFLOW_RENDER_DEST="/opt/aiflow-render"

echo "[redeploy-render] refreshing repo at \${NEWCOWORKER_REPO_PATH} (ref=\${NEWCOWORKER_REPO_REF})"
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

if [[ ! -d "\${AIFLOW_RENDER_SRC}" || ! -f "\${AIFLOW_RENDER_SRC}/docker-compose.yml" ]]; then
  echo "missing render source at \${AIFLOW_RENDER_SRC}" >&2
  exit 1
fi
if [[ ! -f "\${AIFLOW_RENDER_DEST}/.env" ]]; then
  echo "no existing \${AIFLOW_RENDER_DEST}/.env — run the full deploy-client.sh instead" >&2
  exit 1
fi

echo "[redeploy-render] rsync \${AIFLOW_RENDER_SRC} -> \${AIFLOW_RENDER_DEST}"
mkdir -p "\${AIFLOW_RENDER_DEST}"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \\
    --exclude ".env" \\
    --exclude "node_modules" \\
    "\${AIFLOW_RENDER_SRC}/" "\${AIFLOW_RENDER_DEST}/"
else
  cp -R "\${AIFLOW_RENDER_SRC}/." "\${AIFLOW_RENDER_DEST}/"
fi

echo "[redeploy-render] docker compose up -d --build --force-recreate"
cd "\${AIFLOW_RENDER_DEST}"
docker compose up -d --build --force-recreate

echo "[redeploy-render] polling http://127.0.0.1:8080/health (60s budget)"
for _ in $(seq 1 30); do
  if curl -sf --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "[redeploy-render] aiflow_render_ready"
    exit 0
  fi
  sleep 2
done
echo "[redeploy-render] aiflow_render_unhealthy: never returned 200 within 60s" >&2
exit 1
`;
}

async function redeployOne(
  target: TenantVpsTarget,
  ref: string,
  hostingerToken: string
): Promise<TenantVpsRedeployResult> {
  const key = await getActiveVpsSshKeyForBusiness(target.businessId);
  if (!key) {
    return { ...target, ok: false, detail: "no_active_ssh_key" };
  }
  const publicIp = await resolveTenantVpsPublicIp(
    target.hostingerVpsId,
    hostingerToken,
    "[redeploy-render]"
  );
  if (!publicIp) {
    return { ...target, ok: false, detail: "no_public_ip" };
  }
  const command = buildRenderRedeployCommand(ref);
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
  loadEnv();
  const args = parseTenantVpsRedeployArgs(
    process.argv.slice(2),
    "Usage: tsx debug/redeploy-aiflow-render.ts [--ref main] [--business <uuid>] [--json]\n"
  );
  ensureNextPublicSupabaseUrlOrExit();
  const hostingerToken = requireServiceRoleAndHostingerToken();

  const targets = (await listTenantVpsTargets(args.businessId)).filter((t) => {
    if (t.tier === "starter") {
      process.stderr.write(`skip ${t.businessId}: starter tier has no render sidecar\n`);
      return false;
    }
    return true;
  });
  if (targets.length === 0) {
    process.stdout.write(
      args.businessId
        ? `no render-capable VPS for business ${args.businessId}\n`
        : "no render-capable tenant VPSes provisioned\n"
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
