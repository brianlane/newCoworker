import { HostingerClient } from "@/lib/hostinger/client";
import { sendTelnyxSms, getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";
import { sendOwnerEmail } from "@/lib/email/client";
import { updateBusinessStatus } from "@/lib/db/businesses";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { recordProvisioningProgress } from "@/lib/provisioning/progress";
import {
  cloudflareTunnelProvisionerFromEnv,
  type CloudflareTunnelProvisioner
} from "@/lib/cloudflare/tunnel";

type ProvisioningInput = {
  businessId: string;
  tier: "starter" | "standard" | "enterprise";
  ownerEmail?: string;
  ownerPhone?: string;
};

export type ProvisioningResult = {
  vpsId: string;
  tunnelUrl: string;
};

type VpsProvisioningPlan = {
  hostingerPlan: string;
  snapshotId: string;
};

function resolveProvisioningPlan(tier: ProvisioningInput["tier"]): VpsProvisioningPlan {
  if (tier === "enterprise") {
    const contact = process.env.CONTACT_EMAIL ?? "newcoworkerteam@gmail.com";
    throw new Error(
      `Enterprise provisioning requires a custom engagement. Please contact ${contact} to discuss your needs.`
    );
  }
  const plans: Record<"starter" | "standard", VpsProvisioningPlan> = {
    starter: { hostingerPlan: "kvm2", snapshotId: "gold-image-starter-v1" },
    standard: { hostingerPlan: "kvm8", snapshotId: "gold-image-standard-v1" }
  };
  return plans[tier];
}

function loadSoulTemplate(): string {
  try {
    return readFileSync(join(process.cwd(), "vps/templates/soul.md"), "utf-8");
  } catch {
    return "# soul.md\nYou are a professional AI coworker. Follow Fair Housing Act guardrails at all times.";
  }
}

function loadIdentityTemplate(): string {
  try {
    return readFileSync(join(process.cwd(), "vps/templates/identity.md"), "utf-8");
  } catch {
    return "# identity.md\nBusiness Name: {{business_name}}";
  }
}

/** Bash `printf %q` when available; safe single-quote fallback (testable via `child_process` mock). */
export function quoteShellEnvValue(value: string): string {
  try {
    const r = spawnSync("bash", ["-c", 'printf %q "$1"', "_", value], { encoding: "utf8" });
    if (r.status === 0 && typeof r.stdout === "string" && r.stdout.length > 0) {
      return r.stdout.trimEnd();
    }
  } catch {
    /* e.g. Windows dev without bash */
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function orchestrateProvisioning(
  input: ProvisioningInput,
  deps?: {
    hostinger?: HostingerClient;
    /** Override env value quoting (defaults to {@link quoteShellEnvValue}). */
    quoteEnv?: (value: string) => string;
    /**
     * Per-tenant Cloudflare Tunnel provisioner. When null the orchestrator
     * falls back to the shared CLOUDFLARE_TUNNEL_TOKEN env var (legacy path).
     * When undefined we resolve one from env (CLOUDFLARE_API_TOKEN +
     * CLOUDFLARE_ACCOUNT_ID); this keeps tests hermetic and production
     * feature-flagged purely by what secrets are present.
     */
    cloudflareTunnel?: CloudflareTunnelProvisioner | null;
  }
): Promise<ProvisioningResult> {
  const { businessId, ownerEmail, ownerPhone, tier } = input;
  const plan = resolveProvisioningPlan(tier);

  logger.info("Starting provisioning", { businessId, tier, plan });

  await recordProvisioningProgress({
    businessId,
    phase: "started",
    percent: 5,
    message: "Provisioning started",
    source: "orchestrator"
  });

  const hostinger =
    deps?.hostinger ??
    new HostingerClient(
      process.env.HOSTINGER_API_BASE_URL ?? "https://developers.hostinger.com",
      process.env.HOSTINGER_API_TOKEN ?? ""
    );

  const { vpsId } = await hostinger.provisionVps(plan.hostingerPlan, plan.snapshotId);
  logger.info("VPS provisioned", { businessId, vpsId });

  await recordProvisioningProgress({
    businessId,
    phase: "vps_provisioned",
    percent: 15,
    message: `VPS provisioned (${vpsId})`,
    source: "orchestrator"
  });

  await updateBusinessStatus(businessId, "offline", vpsId);

  const existingConfig = await getBusinessConfig(businessId);
  await upsertBusinessConfig({
    business_id: businessId,
    soul_md: existingConfig?.soul_md ?? loadSoulTemplate(),
    identity_md: existingConfig?.identity_md ?? loadIdentityTemplate(),
    memory_md: existingConfig?.memory_md ?? "# memory.md\nLossless memory DAG initialized."
  });

  await recordProvisioningProgress({
    businessId,
    phase: "config_upserted",
    percent: 25,
    message: "Business config written to Supabase",
    source: "orchestrator"
  });

  await recordProvisioningProgress({
    businessId,
    phase: "telnyx_voice_ready",
    percent: 32,
    message: "Voice is Telnyx + VPS bridge (configure DIDs and Edge webhooks in Mission Control)",
    source: "orchestrator"
  });

  // Per-tenant Cloudflare Tunnel: resolve (or create) a dedicated tunnel for
  // this business and use its install token + hostname. Falls back to the
  // legacy shared CLOUDFLARE_TUNNEL_TOKEN env var when CF API creds aren't
  // configured, preserving backward compatibility for dev/test environments.
  const tunnelProvisioner =
    deps?.cloudflareTunnel === undefined
      ? cloudflareTunnelProvisionerFromEnv()
      : deps.cloudflareTunnel;

  let tunnelHostname = `${businessId}.tunnel.newcoworker.com`;
  let cloudflareTunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
  // Voice bridge public origin. When the per-tenant CF tunnel succeeds we
  // synthesize a deterministic `wss://voice-<biz>.<suffix>` so Telnyx gets a
  // CF-issued TLS cert with zero per-VPS Caddy/Let's Encrypt work. When the
  // tunnel is disabled or fails we fall back to the operator-provided env var
  // (legacy single-bridge deployments, or a shared voice fleet fronted by
  // something else).
  let bridgeMediaWssOrigin = process.env.BRIDGE_MEDIA_WSS_ORIGIN ?? "";
  if (tunnelProvisioner) {
    try {
      const provisioned = await tunnelProvisioner({ businessId });
      tunnelHostname = provisioned.hostname;
      cloudflareTunnelToken = provisioned.token;
      bridgeMediaWssOrigin = `wss://${provisioned.voiceHostname}`;
      await recordProvisioningProgress({
        businessId,
        phase: "cloudflare_tunnel_ready",
        percent: 35,
        message: `Per-tenant tunnel ready (${provisioned.tunnelId}); voice origin ${bridgeMediaWssOrigin}`,
        source: "orchestrator"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Cloudflare tunnel provisioning failed", { businessId, error: msg });
      await recordProvisioningProgress({
        businessId,
        phase: "cloudflare_tunnel_failed",
        percent: 35,
        message: `Cloudflare tunnel provisioning failed: ${msg}`,
        source: "orchestrator",
        status: "error"
      });
      // Fall through with the env-var token so a broken CF API doesn't wedge
      // a deploy when the operator has a valid shared token available.
    }
  }

  const tunnelUrl = `https://${tunnelHostname}`;

  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";

  const bashQuote = deps?.quoteEnv ?? quoteShellEnvValue;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const progressUrl = `${appUrl.replace(/\/$/, "")}/api/provisioning/progress`;
  const progressToken = process.env.PROVISIONING_PROGRESS_TOKEN ?? process.env.ROWBOAT_GATEWAY_TOKEN ?? "";

  const envVars = [
    ["BUSINESS_ID", businessId],
    ["TIER", tier],
    ["SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""],
    ["SUPABASE_SERVICE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""],
    ["ROWBOAT_GATEWAY_TOKEN", gatewayToken],
    ["NOTIFICATIONS_WEBHOOK_TOKEN", process.env.NOTIFICATIONS_WEBHOOK_TOKEN ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""],
    ["TELNYX_API_KEY", process.env.TELNYX_API_KEY ?? ""],
    ["TELNYX_MESSAGING_PROFILE_ID", process.env.TELNYX_MESSAGING_PROFILE_ID ?? ""],
    ["TELNYX_SMS_FROM_E164", process.env.TELNYX_SMS_FROM_E164 ?? ""],
    ["STREAM_URL_SIGNING_SECRET", process.env.STREAM_URL_SIGNING_SECRET ?? ""],
    ["BRIDGE_MEDIA_WSS_ORIGIN", bridgeMediaWssOrigin],
    // Voice bridge (Gemini Live): blank GOOGLE_API_KEY disables Live on the bridge
    // (primary kill switch). GEMINI_LIVE_ENABLED is the secondary rollout flag
    // (bridge keeps the media WS up but mutes AI audio when "false"). We forward
    // it as-is; deploy-client.sh preserves any existing VPS-side value when this
    // is empty, so orchestrator-level control and per-VPS overrides both work.
    // VOICE_BRIDGE_SRC lets ops override the on-VPS sync path.
    ["GOOGLE_API_KEY", process.env.GOOGLE_API_KEY ?? ""],
    ["GEMINI_LIVE_MODEL", process.env.GEMINI_LIVE_MODEL ?? ""],
    ["GEMINI_LIVE_ENABLED", process.env.GEMINI_LIVE_ENABLED ?? ""],
    ["VOICE_BRIDGE_SRC", process.env.VOICE_BRIDGE_SRC ?? ""],
    ["CLOUDFLARE_TUNNEL_TOKEN", cloudflareTunnelToken],
    ["LIGHTPANDA_WSS_URL", process.env.LIGHTPANDA_WSS_URL ?? "wss://cdn.lightpanda.io/ws"],
    ["PROVISIONING_PROGRESS_URL", progressUrl],
    ["PROVISIONING_PROGRESS_TOKEN", progressToken]
  ].map(([key, value]) => `${key}=${bashQuote(value)}`).join(" ");

  await recordProvisioningProgress({
    businessId,
    phase: "remote_deploy_starting",
    percent: 40,
    message: "Running deploy-client.sh on VPS",
    source: "orchestrator"
  });

  let deploySucceeded = false;
  try {
    const { exitCode, output } = await hostinger.executeCommand(
      vpsId,
      `${envVars} /opt/deploy-client.sh`
    );
    if (exitCode !== 0) {
      logger.error("deploy-client.sh failed", { businessId, vpsId, exitCode, output });
      await recordProvisioningProgress({
        businessId,
        phase: "deploy_failed",
        percent: 95,
        message: `deploy-client.sh exit ${exitCode}: ${(output ?? "").slice(0, 2000)}`,
        source: "orchestrator",
        status: "error"
      });
    } else {
      deploySucceeded = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Remote deploy execution failed — VPS may need manual setup", {
      businessId,
      vpsId,
      error: msg
    });
    await recordProvisioningProgress({
      businessId,
      phase: "deploy_exception",
      percent: 95,
      message: msg,
      source: "orchestrator",
      status: "error"
    });
  }

  await updateBusinessStatus(businessId, "online", vpsId);
  if (deploySucceeded) {
    await recordProvisioningProgress({
      businessId,
      phase: "complete",
      percent: 100,
      message: "Coworker provisioning complete (orchestrator)",
      source: "orchestrator",
      status: "success"
    });
  }
  logger.info("Business provisioned and online", { businessId, vpsId });

  const notifyEmail = ownerEmail ?? process.env.ADMIN_EMAIL;
  const notifyPhone = ownerPhone ?? process.env.TELNYX_OWNER_PHONE;
  const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/dashboard`;

  if (notifyEmail) {
    try {
      await sendOwnerEmail(
        process.env.RESEND_API_KEY ?? "",
        notifyEmail,
        "Your AI Coworker is live!",
        `Your New Coworker is set up and ready. Visit your dashboard: ${dashboardUrl}`
      );
    } catch (err) {
      logger.warn("Failed to send provisioning email", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (notifyPhone) {
    try {
      const cfg = await getTelnyxMessagingForBusiness(businessId);
      // Provisioning ping to owner: platform-operational; not metered against the business SMS quota.
      await sendTelnyxSms(cfg, notifyPhone, `Your New Coworker is live! Dashboard: ${dashboardUrl}`);
    } catch (err) {
      logger.warn("Failed to send provisioning SMS", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { vpsId, tunnelUrl };
}
