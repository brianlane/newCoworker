import { HostingerClient } from "@/lib/hostinger/client";
import { InworldClient } from "@/lib/inworld/client";
import { sendOwnerSms, readTwilioConfig } from "@/lib/twilio/client";
import { sendOwnerEmail } from "@/lib/email/client";
import { updateBusinessStatus } from "@/lib/db/businesses";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";
import { readFileSync } from "fs";
import { join } from "path";
import { recordProvisioningProgress } from "@/lib/provisioning/progress";

type ProvisioningInput = {
  businessId: string;
  tier: "starter" | "standard" | "enterprise";
  ownerEmail?: string;
  ownerPhone?: string;
};

type ProvisioningResult = {
  vpsId: string;
  agentId: string;
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

export async function orchestrateProvisioning(
  input: ProvisioningInput,
  deps?: {
    hostinger?: HostingerClient;
    inworld?: InworldClient;
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

  // 1. Provision VPS via Hostinger API
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

  // 2. Store VPS ID and mark offline while setting up
  await updateBusinessStatus(businessId, "offline", vpsId);

  // 3. Upsert soul/identity config in Supabase
  const existingConfig = await getBusinessConfig(businessId);
  await upsertBusinessConfig({
    business_id: businessId,
    soul_md: existingConfig?.soul_md ?? loadSoulTemplate(),
    identity_md: existingConfig?.identity_md ?? loadIdentityTemplate(),
    memory_md: existingConfig?.memory_md ?? "# memory.md\nLossless memory DAG initialized.",
    inworld_agent_id: existingConfig?.inworld_agent_id ?? null
  });

  await recordProvisioningProgress({
    businessId,
    phase: "config_upserted",
    percent: 25,
    message: "Business config written to Supabase",
    source: "orchestrator"
  });

  // 4. Create inworld.ai voice agent (all tiers use inworld-tts-1.5-mini)
  const tunnelUrl = `https://${businessId}.tunnel.newcoworker.com`;

  const inworld =
    deps?.inworld ??
    new InworldClient(process.env.INWORLD_API_KEY ?? "");

  const { agent_id: agentId } = await inworld.createVoiceAgent(
    `rowboat_agent_${businessId.slice(0, 8)}`,
    undefined
  );

  // 5. Store inworld agent ID
  await upsertBusinessConfig({
    business_id: businessId,
    soul_md: existingConfig?.soul_md ?? loadSoulTemplate(),
    identity_md: existingConfig?.identity_md ?? loadIdentityTemplate(),
    memory_md: existingConfig?.memory_md ?? "# memory.md\nLossless memory DAG initialized.",
    inworld_agent_id: agentId
  });

  await recordProvisioningProgress({
    businessId,
    phase: "inworld_agent_ready",
    percent: 35,
    message: `Inworld voice agent created (${agentId})`,
    source: "orchestrator"
  });

  // 6. Execute deploy-client.sh on the VPS
  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";

  // Build environment safely using printf %q for shell escaping
  // Each var=printf '%s=%q\n' prevents injection via shell metacharacters
  const escapeShellArg = (str: string): string => {
    // Use bash %q escaping: single-quote special chars, escape single quotes
    return str.replace(/'/g, "'\\''");
  };

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
    ["INWORLD_AGENT_ID", agentId],
    ["INWORLD_API_KEY", process.env.INWORLD_API_KEY ?? ""],
    ["CLOUDFLARE_TUNNEL_TOKEN", process.env.CLOUDFLARE_TUNNEL_TOKEN ?? ""],
    ["LIGHTPANDA_WSS_URL", process.env.LIGHTPANDA_WSS_URL ?? "wss://cdn.lightpanda.io/ws"],
    ["PROVISIONING_PROGRESS_URL", progressUrl],
    ["PROVISIONING_PROGRESS_TOKEN", progressToken]
  ].map(([key, value]) => `${key}='${escapeShellArg(value)}'`).join(" ");

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
      businessId, vpsId,
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

  // 7. Mark business as online (preserves prior behavior: status online even if deploy script failed)
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
  logger.info("Business provisioned and online", { businessId, agentId });

  // 8. Notify owner
  const notifyEmail = ownerEmail ?? process.env.ADMIN_EMAIL;
  const notifyPhone = ownerPhone ?? process.env.TWILIO_OWNER_PHONE;
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
      const twilioConfig = readTwilioConfig();
      await sendOwnerSms(
        twilioConfig,
        notifyPhone,
        `Your New Coworker is live! Dashboard: ${dashboardUrl}`
      );
    } catch (err) {
      logger.warn("Failed to send provisioning SMS", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { vpsId, agentId, tunnelUrl };
}
