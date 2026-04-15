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
    memory_md: existingConfig?.memory_md ?? "# memory.md\nLossless memory DAG initialized.",
    inworld_agent_id: null
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

  const tunnelUrl = `https://${businessId}.tunnel.newcoworker.com`;

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
    ["BRIDGE_MEDIA_WSS_ORIGIN", process.env.BRIDGE_MEDIA_WSS_ORIGIN ?? ""],
    ["CLOUDFLARE_TUNNEL_TOKEN", process.env.CLOUDFLARE_TUNNEL_TOKEN ?? ""],
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
  const notifyPhone = ownerPhone ?? process.env.TELNYX_OWNER_PHONE ?? process.env.TWILIO_OWNER_PHONE;
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
      await sendTelnyxSms(cfg, notifyPhone, `Your New Coworker is live! Dashboard: ${dashboardUrl}`, {
        meterBusinessId: businessId
      });
    } catch (err) {
      logger.warn("Failed to send provisioning SMS", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { vpsId, tunnelUrl };
}
