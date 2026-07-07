#!/usr/bin/env tsx
/**
 * Full `deploy-client.sh` rollout across every per-tenant VPS (automated —
 * uses the same programmatic SSH path as `redeploy-voice-bridge.ts`, not an
 * interactive SSH session).
 *
 * What it does on each host:
 *   1. `git fetch` + `checkout` the requested ref in `/opt/newcoworker-repo`
 *   2. `install` fresh `vps/scripts/deploy-client.sh` → `/opt/deploy-client.sh`
 *   3. Run `/opt/deploy-client.sh` with the **same env injection shape** as
 *      `src/lib/provisioning/orchestrate.ts` (BUSINESS_ID + TIER per row, plus
 *      platform secrets from the caller's process env)
 *
 * This re-seeds Rowboat Mongo (workflow/agents), rewrites vault, restarts
 * voice-bridge + chat-worker, etc. — the same as initial provision's deploy
 * phase, **without** buying a new VM.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/redeploy-deploy-client.ts
 *   npx tsx scripts/redeploy-deploy-client.ts --ref main
 *   npx tsx scripts/redeploy-deploy-client.ts --business <uuid>
 *   npx tsx scripts/redeploy-deploy-client.ts --json
 *
 * Per-tenant gateway token: each box is deployed with its OWN unique gateway
 * token (the bearer / Rowboat tool-call JWT secret / outbound API key), resolved
 * or minted per business from `vps_gateway_tokens` and CONFIRMED after a
 * successful deploy. The shared platform `ROWBOAT_GATEWAY_TOKEN` env value is NO
 * LONGER injected onto boxes here — it stays a platform-internal secret. Running
 * this against a legacy box still on the shared token therefore ROTATES it onto a
 * fresh per-tenant token.
 *
 * Required env (mirrors orchestrator + voice-bridge redeploy):
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL alone — we alias it for you)
 *   SUPABASE_SERVICE_ROLE_KEY
 *   HOSTINGER_API_TOKEN
 *   TELNYX_* (see orchestrate.ts envVars), etc.
 *
 * Per-tenant voice: when `BRIDGE_MEDIA_WSS_ORIGIN` is not set on the runner,
 * the script loads `media_wss_origin` / `bridge_media_wss_origin` from
 * Supabase for each business so a fleet redeploy does not blank the bridge.
 *
 * Optional:
 *   INTERNAL_CRON_SECRET — written into chat-worker .env (summarizer callback)
 *   CLOUDFLARE_TUNNEL_TOKEN — omit on redeploy if tunnel already on host;
 *      empty avoids re-running `cloudflared service install`
 *
 * Keep {@link buildDeployEnvPrefix} in sync with `runOrchestrator`'s envVars
 * block when adding new deploy-time secrets.
 */

import { getActiveVpsSshKeyForBusiness } from "@/lib/db/vps-ssh-keys";
import {
  getBusinessTelnyxSettings,
  getTelnyxVoiceRouteForBusiness
} from "@/lib/db/telnyx-routes";
import {
  getActiveGatewayTokenForBusiness,
  issueGatewayToken,
  markGatewayTokenDeployed
} from "@/lib/db/vps-gateway-tokens";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { quoteShellEnvValue } from "@/lib/provisioning/orchestrate";
import { resolveDeployedVpsSize } from "@/lib/vps/size";
import { sshExec } from "@/lib/hostinger/ssh";
import {
  assertSafeGitRef,
  ensureNextPublicSupabaseUrlOrExit,
  listTenantVpsTargets,
  parseTenantVpsRedeployArgs,
  requireServiceRoleAndHostingerToken,
  resolveTenantVpsPublicIp,
  type TenantVpsRedeployResult,
  type TenantVpsTarget
} from "./lib/redeploy-tenant-vps";

/**
 * Must stay aligned with `runOrchestrator` deploy phase (orchestrate.ts ~822).
 *
 * `gatewayToken` is the PER-TENANT gateway token for this box (resolved/minted by
 * the caller), NOT the shared platform `ROWBOAT_GATEWAY_TOKEN` env value — the box's
 * `ROWBOAT_GATEWAY_TOKEN`, its Rowboat tool-call JWT secret, and its outbound API key
 * are all this unique token, so a redeploy rotates the box onto its own secret instead
 * of re-stamping the shared one.
 */
function buildDeployEnvPrefix(
  businessId: string,
  deployTier: "starter" | "standard",
  deployVpsSize: "kvm1" | "kvm2" | "kvm4" | "kvm8",
  bridgeMediaWssOrigin: string,
  gatewayToken: string,
  repoRef: string,
  dataResidencyEnabled: boolean
): string {
  const bashQuote = quoteShellEnvValue;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const progressUrl = `${appUrl.replace(/\/$/, "")}/api/provisioning/progress`;
  // No new secret on the box: the per-tenant token is already its ROWBOAT_GATEWAY_TOKEN,
  // so the in-deploy progress callback authenticates via the inbound binding.
  const progressToken = process.env.PROVISIONING_PROGRESS_TOKEN ?? gatewayToken;

  const pairs: Array<[string, string]> = [
    ["BUSINESS_ID", businessId],
    ["TIER", deployTier],
    // Hardware profile (Ollama fallback model selection). Without this a
    // redeploy of a standard-tenant-on-kvm2 box would fall back to the tier
    // default and pull the KVM8 model onto 8GB hardware.
    ["VPS_SIZE", deployVpsSize],
    // deploy-client.sh re-pins /opt/newcoworker-repo to NEWCOWORKER_REPO_REF
    // (default "main") before it rsyncs+builds chat-worker / voice-bridge /
    // aiflow-render. Pass the requested ref through so `--ref` actually controls
    // what gets BUILT, not just which deploy-client.sh runs — otherwise a branch
    // redeploy silently builds those components from main.
    ["NEWCOWORKER_REPO_REF", repoRef],
    ["SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ""],
    ["SUPABASE_SERVICE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""],
    ["ROWBOAT_GATEWAY_TOKEN", gatewayToken],
    ["NOTIFICATIONS_WEBHOOK_TOKEN", process.env.NOTIFICATIONS_WEBHOOK_TOKEN ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""],
    ["TELNYX_API_KEY", process.env.TELNYX_API_KEY ?? ""],
    ["TELNYX_MESSAGING_PROFILE_ID", process.env.TELNYX_MESSAGING_PROFILE_ID ?? ""],
    ["TELNYX_SMS_FROM_E164", process.env.TELNYX_SMS_FROM_E164 ?? ""],
    ["STREAM_URL_SIGNING_SECRET", process.env.STREAM_URL_SIGNING_SECRET ?? ""],
    ["BRIDGE_MEDIA_WSS_ORIGIN", bridgeMediaWssOrigin],
    ["GOOGLE_API_KEY", process.env.GOOGLE_API_KEY ?? ""],
    ["GEMINI_LIVE_MODEL", process.env.GEMINI_LIVE_MODEL ?? ""],
    ["GEMINI_LIVE_ENABLED", process.env.GEMINI_LIVE_ENABLED ?? ""],
    ["VOICE_TRANSCRIPTION_ENABLED", process.env.VOICE_TRANSCRIPTION_ENABLED ?? ""],
    ["GEMINI_ROWBOAT_MODEL", process.env.GEMINI_ROWBOAT_MODEL ?? ""],
    ["OWNER_CHAT_MODEL", process.env.OWNER_CHAT_MODEL ?? ""],
    ["APP_BASE_URL", process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? ""],
    ["VOICE_BRIDGE_SRC", process.env.VOICE_BRIDGE_SRC ?? ""],
    ["AIFLOW_RENDER_TOKEN", process.env.AIFLOW_RENDER_TOKEN ?? ""],
    // Mirror the orchestrator's residency gate: deploy-client.sh tears the
    // data-api stack down when this is not exactly "true", so a fleet
    // redeploy that omitted it would stop an opted-in enterprise tenant's
    // datastore.
    ["DATA_RESIDENCY_ENABLED", dataResidencyEnabled ? "true" : ""],
    ["CLOUDFLARE_TUNNEL_TOKEN", process.env.CLOUDFLARE_TUNNEL_TOKEN ?? ""],
    ["PROVISIONING_PROGRESS_URL", progressUrl],
    ["PROVISIONING_PROGRESS_TOKEN", progressToken],
    ["INTERNAL_CRON_SECRET", process.env.INTERNAL_CRON_SECRET ?? ""]
  ];

  return pairs.map(([k, v]) => `${k}=${bashQuote(v)}`).join(" ");
}

function deployTierFromBusinessTier(tier: string): "starter" | "standard" {
  return tier === "starter" ? "starter" : "standard";
}

/**
 * BRIDGE_MEDIA_WSS_ORIGIN: optional platform-wide override, else per-tenant
 * DB (matches telnyx-voice-inbound resolution).
 */
async function resolveBridgeMediaWssOrigin(businessId: string): Promise<string> {
  const globalOverride = process.env.BRIDGE_MEDIA_WSS_ORIGIN?.trim();
  if (globalOverride) return globalOverride;
  const db = await createSupabaseServiceClient();
  const [route, settings] = await Promise.all([
    getTelnyxVoiceRouteForBusiness(businessId, db),
    getBusinessTelnyxSettings(businessId, db)
  ]);
  const fromRoute = route?.media_wss_origin?.trim() ?? "";
  if (fromRoute) return fromRoute;
  return settings?.bridge_media_wss_origin?.trim() ?? "";
}

function buildRedeployCommand(ref: string, envPrefix: string): string {
  assertSafeGitRef(ref);
  return `set -euo pipefail
NEWCOWORKER_REPO_PATH="/opt/newcoworker-repo"
NEWCOWORKER_REPO_REF='${ref}'
NEWCOWORKER_REPO_URL="https://github.com/brianlane/newCoworker.git"

echo "[redeploy-deploy-client] refreshing repo at \${NEWCOWORKER_REPO_PATH} (ref=\${NEWCOWORKER_REPO_REF})"
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

if [[ ! -f "\${NEWCOWORKER_REPO_PATH}/vps/scripts/deploy-client.sh" ]]; then
  echo "missing deploy-client.sh at \${NEWCOWORKER_REPO_PATH}/vps/scripts/deploy-client.sh" >&2
  exit 1
fi

install -m 0755 "\${NEWCOWORKER_REPO_PATH}/vps/scripts/deploy-client.sh" /opt/deploy-client.sh
echo "[redeploy-deploy-client] running /opt/deploy-client.sh"
${envPrefix} /opt/deploy-client.sh
`;
}

const DEPLOY_SSH_TIMEOUT_MS = 900_000;

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
    "[redeploy-deploy-client]"
  );
  if (!publicIp) {
    return { ...target, ok: false, detail: "no_public_ip" };
  }
  // Per-tenant gateway token: reuse the business's existing (pending or confirmed)
  // token, or mint a fresh PENDING one, and inject IT as the box's
  // ROWBOAT_GATEWAY_TOKEN. After a successful deploy we CONFIRM it
  // (`markGatewayTokenDeployed`), which revokes any older token and flips
  // outbound/JWT verification onto the per-tenant secret — mirroring
  // orchestrate.ts. This is what lets a redeploy ROTATE a legacy box off the
  // shared platform token onto its own unique one, and keeps a routine fleet
  // redeploy from ever re-stamping the shared token over a rotated tenant.
  const existing = await getActiveGatewayTokenForBusiness(target.businessId);
  const gatewayToken =
    existing ?? (await issueGatewayToken(target.businessId, { label: "vps-redeploy" }));
  const tier = deployTierFromBusinessTier(target.tier);
  // Deployed-box resolver: an unpinned starter is a legacy KVM2 box, not the
  // new kvm1 default — the redeploy profile must match the actual hardware.
  const vpsSize = resolveDeployedVpsSize(tier, target.vpsSize);
  const bridgeOrigin = await resolveBridgeMediaWssOrigin(target.businessId);
  // Same gate as orchestrate.ts: REAL tier + data_residency_mode past
  // 'supabase'. Forwarded so a routine fleet roll preserves (or correctly
  // tears down) the tenant's data-api stack.
  const dataResidencyEnabled =
    target.tier === "enterprise" &&
    (target.dataResidencyMode ?? "supabase") !== "supabase";
  const envPrefix = buildDeployEnvPrefix(
    target.businessId,
    tier,
    vpsSize,
    bridgeOrigin,
    gatewayToken,
    ref,
    dataResidencyEnabled
  );
  const command = buildRedeployCommand(ref, envPrefix);
  try {
    const result = await sshExec({
      host: publicIp,
      port: 22,
      username: key.ssh_username,
      privateKeyPem: key.private_key_pem,
      command,
      timeoutMs: DEPLOY_SSH_TIMEOUT_MS
    });
    const stdoutTail = (result.stdout || "").split("\n").slice(-20).join("\n");
    if (result.exitCode === 0) {
      // Non-fatal on failure: the box already serves the new (still-pending) secret,
      // which inbound JWT verification accepts; a later redeploy reuses + re-confirms.
      try {
        await markGatewayTokenDeployed(target.businessId, gatewayToken);
      } catch (err) {
        process.stderr.write(
          `[redeploy-deploy-client] gateway-token confirm failed for ${target.businessId} (deploy OK, left pending): ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
      return { ...target, ok: true, publicIp, exitCode: 0, stdoutTail };
    }
    return {
      ...target,
      ok: false,
      publicIp,
      exitCode: result.exitCode,
      detail: `ssh exit ${result.exitCode}`,
      stdoutTail: `${stdoutTail}\n--stderr--\n${(result.stderr || "").slice(-1200)}`
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
    "Usage: tsx scripts/redeploy-deploy-client.ts [--ref main] [--business <uuid>] [--json]\n"
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
