import { HostingerClient } from "@/lib/hostinger/client";
import { InworldClient } from "@/lib/inworld/client";
import { sendOwnerSms, readTwilioConfig } from "@/lib/twilio/client";
import { sendOwnerEmail } from "@/lib/email/client";
import { updateBusinessStatus } from "@/lib/db/businesses";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";
import { readFileSync } from "fs";
import { join } from "path";

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

  // 1. Provision VPS via Hostinger API
  const hostinger =
    deps?.hostinger ??
    new HostingerClient(
      process.env.HOSTINGER_API_BASE_URL ?? "https://developers.hostinger.com",
      process.env.HOSTINGER_API_TOKEN ?? ""
    );

  const { vpsId } = await hostinger.provisionVps(plan.hostingerPlan, plan.snapshotId);
  logger.info("VPS provisioned", { businessId, vpsId });

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

  // 4. Create inworld.ai voice agent (all tiers use inworld-tts-1.5-mini)
  const tunnelUrl = `https://${businessId}.tunnel.newcoworker.com`;
  const customLlmUrl = `${tunnelUrl}/v1/chat/completions`;

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

  // 6. Execute deploy-client.sh on the VPS
  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  const deployEnv = [
    `BUSINESS_ID=${businessId}`,
    `TIER=${tier}`,
    `SUPABASE_URL=${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}`,
    `SUPABASE_SERVICE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
    `ROWBOAT_GATEWAY_TOKEN=${gatewayToken}`,
    `NOTIFICATIONS_WEBHOOK_TOKEN=${process.env.NOTIFICATIONS_WEBHOOK_TOKEN ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
    `INWORLD_AGENT_ID=${agentId}`,
    `INWORLD_API_KEY=${process.env.INWORLD_API_KEY ?? ""}`,
    `CLOUDFLARE_TUNNEL_TOKEN=${process.env.CLOUDFLARE_TUNNEL_TOKEN ?? ""}`,
    `LIGHTPANDA_WSS_URL=${process.env.LIGHTPANDA_WSS_URL ?? "wss://cdn.lightpanda.io/ws"}`
  ].join(" ");

  void customLlmUrl; // referenced in future Rowboat config injection

  try {
    const { exitCode, output } = await hostinger.executeCommand(
      vpsId,
      `${deployEnv} /opt/deploy-client.sh`
    );
    if (exitCode !== 0) {
      logger.error("deploy-client.sh failed", { businessId, vpsId, exitCode, output });
    }
  } catch (err) {
    logger.error("Remote deploy execution failed — VPS may need manual setup", {
      businessId, vpsId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // 7. Mark business as online
  await updateBusinessStatus(businessId, "online", vpsId);
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
