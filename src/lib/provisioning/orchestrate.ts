import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import {
  provisionVpsForBusiness,
  buildDefaultPostInstallScript,
  type ProvisionVpsForBusinessResult
} from "@/lib/hostinger/provision";
import { sshExec, type SshExecResult } from "@/lib/hostinger/ssh";
import { sendTelnyxSms, getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import {
  orderAndAssignDidForBusiness,
  OrderAndAssignError,
  type PlatformTelnyxDefaults
} from "@/lib/telnyx/assign-did";
import { readPlatformTelnyxDefaults } from "@/lib/telnyx/platform-defaults";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";
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

function resolveStarterOrStandard(tier: ProvisioningInput["tier"]): "starter" | "standard" {
  if (tier === "enterprise") {
    const contact = process.env.CONTACT_EMAIL ?? "newcoworkerteam@gmail.com";
    throw new Error(
      `Enterprise provisioning requires a custom engagement. Please contact ${contact} to discuss your needs.`
    );
  }
  return tier;
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

/**
 * Executor interface the orchestrator uses to reach the VPS over SSH.
 * Defaults to {@link sshExec} but is injectable for testing.
 */
export type RemoteExecutor = (args: {
  host: string;
  username: string;
  privateKeyPem: string;
  command: string;
}) => Promise<SshExecResult>;

/* c8 ignore start -- production-only default; tests inject remoteExec */
const defaultRemoteExecutor: RemoteExecutor = (args) =>
  sshExec({
    host: args.host,
    username: args.username,
    privateKeyPem: args.privateKeyPem,
    command: args.command
  });
/* c8 ignore stop */

/**
 * Factory for the VPS provisioning step. Split out from {@link orchestrateProvisioning}
 * so tests can stub the entire "talk to Hostinger + mint SSH key" sequence in
 * one swap.
 */
export type VpsProvisioner = (input: {
  businessId: string;
  tier: "starter" | "standard";
}) => Promise<ProvisionVpsForBusinessResult>;

/**
 * Provisioner for the per-tenant DID purchase + assignment step. Split out so
 * tests can stub the Telnyx order-and-assign flow without touching the live
 * Telnyx API.
 *
 * The flow is **opt-in**: it only runs when `process.env.TELNYX_AUTO_PURCHASE_DID`
 * is truthy (or the caller injects a provisioner). This keeps the default
 * behavior — "operator manually assigns a DID from the admin UI" — unchanged.
 */
export type DidProvisioner = (input: {
  businessId: string;
  platformDefaults: PlatformTelnyxDefaults;
  search: { countryCode?: string; areaCode?: string; administrativeArea?: string };
}) => Promise<{ toE164: string }>;

/* c8 ignore start -- production-only default factory; tests inject vpsProvisioner */
function defaultVpsProvisioner(client: HostingerClient): VpsProvisioner {
  return ({ businessId, tier }) =>
    provisionVpsForBusiness(
      {
        businessId,
        tier,
        postInstallScript: buildDefaultPostInstallScript()
      },
      { client }
    );
}
/* c8 ignore stop */

/* c8 ignore start -- production-only default factory; tests inject didProvisioner */
function defaultDidProvisioner(): DidProvisioner {
  return async ({ businessId, platformDefaults, search }) => {
    const apiKey = process.env.TELNYX_API_KEY ?? "";
    if (!apiKey) throw new Error("TELNYX_API_KEY missing — cannot auto-purchase DID");
    const telnyxNumbers = new TelnyxNumbersClient({ apiKey });
    const result = await orderAndAssignDidForBusiness(
      { businessId, platformDefaults, search },
      { telnyxNumbers }
    );
    return { toE164: result.route.to_e164 };
  };
}
/* c8 ignore stop */

export async function orchestrateProvisioning(
  input: ProvisioningInput,
  deps?: {
    /** Low-level Hostinger client. Defaults to one built from env. */
    hostinger?: HostingerClient;
    /**
     * High-level provisioner (generates keypair, registers key, purchases
     * VPS, polls for readiness, installs Monarx, persists key). Falls back
     * to the default factory when omitted. Tests typically inject this
     * directly to bypass both Hostinger + DB.
     */
    vpsProvisioner?: VpsProvisioner;
    /** Remote command executor (SSH). Defaults to {@link sshExec}. */
    remoteExec?: RemoteExecutor;
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
    /**
     * DID (phone number) provisioner. When set, runs after Cloudflare tunnel
     * provisioning and purchases/assigns a Telnyx DID for the tenant. When
     * omitted, the step runs only if `TELNYX_AUTO_PURCHASE_DID=true` in env
     * (production default: off, so operators assign DIDs manually from the
     * admin UI). Pass `null` to force-skip during tests.
     */
    didProvisioner?: DidProvisioner | null;
  }
): Promise<ProvisioningResult> {
  const { businessId, ownerEmail, ownerPhone, tier } = input;
  const narrowTier = resolveStarterOrStandard(tier);

  logger.info("Starting provisioning", { businessId, tier: narrowTier });

  await recordProvisioningProgress({
    businessId,
    phase: "started",
    percent: 5,
    message: "Provisioning started",
    source: "orchestrator"
  });

  const hostinger =
    deps?.hostinger ??
    new HostingerClient({
      /* c8 ignore start -- trivial env-default fallbacks */
      baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
      token: process.env.HOSTINGER_API_TOKEN ?? ""
      /* c8 ignore stop */
    });

  /* c8 ignore next -- defaultVpsProvisioner is the production path; tests inject vpsProvisioner */
  const vpsProvisioner = deps?.vpsProvisioner ?? defaultVpsProvisioner(hostinger);
  /* c8 ignore next -- defaultRemoteExecutor is the production path; tests inject remoteExec */
  const remoteExec = deps?.remoteExec ?? defaultRemoteExecutor;

  // Phase 1: purchase + boot the VPS via the real Hostinger API. This also
  // generates the per-VPS keypair, uploads the public half, and persists the
  // private half in `vps_ssh_keys` for later admin access.
  const provisioned = await vpsProvisioner({ businessId, tier: narrowTier });
  const vpsId = String(provisioned.virtualMachineId);
  logger.info("VPS provisioned", {
    businessId,
    vpsId,
    publicIp: provisioned.publicIp
  });

  await recordProvisioningProgress({
    businessId,
    phase: "vps_provisioned",
    percent: 15,
    message: `VPS provisioned (${vpsId}, ${provisioned.publicIp})`,
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

  // Phase 2: per-tenant Cloudflare tunnel (unchanged from previous release).
  const tunnelProvisioner =
    deps?.cloudflareTunnel === undefined
      ? cloudflareTunnelProvisionerFromEnv()
      : deps.cloudflareTunnel;

  let tunnelHostname = `${businessId}.tunnel.newcoworker.com`;
  let cloudflareTunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
  let bridgeMediaWssOrigin = process.env.BRIDGE_MEDIA_WSS_ORIGIN ?? "";
  if (tunnelProvisioner) {
    try {
      const p = await tunnelProvisioner({ businessId });
      tunnelHostname = p.hostname;
      cloudflareTunnelToken = p.token;
      bridgeMediaWssOrigin = `wss://${p.voiceHostname}`;
      await recordProvisioningProgress({
        businessId,
        phase: "cloudflare_tunnel_ready",
        percent: 35,
        message: `Per-tenant tunnel ready (${p.tunnelId}); voice origin ${bridgeMediaWssOrigin}`,
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
    }
  }

  const tunnelUrl = `https://${tunnelHostname}`;

  // Phase 2b: per-tenant DID provisioning (opt-in). Runs after the tunnel so
  // `bridgeMediaWssOrigin` is known and `assign-did` can persist it into
  // `business_telnyx_settings` alongside the routing row. Any failure is
  // recorded as an error log but does not abort the deploy — the operator can
  // assign a DID manually from the admin UI afterwards.
  const shouldAutoOrderDid =
    deps?.didProvisioner === undefined
      ? process.env.TELNYX_AUTO_PURCHASE_DID === "true"
      : deps.didProvisioner !== null;
  if (shouldAutoOrderDid) {
    /* c8 ignore next -- tests always inject deps.didProvisioner when shouldAutoOrderDid is true */
    const didProvisioner = deps?.didProvisioner ?? defaultDidProvisioner();
    try {
      // Look up the existing route inside the try so a transient Supabase
      // failure (network blip, missing relation mid-rollout, etc.) degrades
      // gracefully into "log and continue" instead of aborting the deploy.
      const existingRoute = await getTelnyxVoiceRouteForBusiness(businessId);
      if (existingRoute) {
        await recordProvisioningProgress({
          businessId,
          phase: "did_already_assigned",
          percent: 37,
          message: `DID already assigned (${existingRoute.to_e164}); skipping order`,
          source: "orchestrator"
        });
      } else {
        const platformDefaults: PlatformTelnyxDefaults = {
          ...readPlatformTelnyxDefaults(),
          // Only override the platform default when we actually resolved a
          // concrete origin. If the tunnel provisioner failed (or isn't
          // configured) AND BRIDGE_MEDIA_WSS_ORIGIN is empty, the local is
          // "" — spreading that would clobber the `undefined` default,
          // bypass the `?? null` fallback downstream, and persist "" into
          // telnyx_voice_routes.media_wss_origin, producing a malformed
          // wss:// URL for the inbound-voice edge function.
          ...(bridgeMediaWssOrigin ? { bridgeMediaWssOrigin } : {})
        };
        const { toE164 } = await didProvisioner({
          businessId,
          platformDefaults,
          search: {
            countryCode: process.env.TELNYX_DEFAULT_COUNTRY ?? "US",
            areaCode: process.env.TELNYX_DEFAULT_AREA_CODE,
            administrativeArea: process.env.TELNYX_DEFAULT_STATE
          }
        });
        await recordProvisioningProgress({
          businessId,
          phase: "did_assigned",
          percent: 38,
          message: `Per-tenant DID assigned (${toE164})`,
          source: "orchestrator"
        });
      }
    } catch (err) {
      const reason =
        err instanceof OrderAndAssignError ? err.reason : err instanceof Error ? err.message : String(err);
      logger.error("DID provisioning failed", { businessId, reason });
      await recordProvisioningProgress({
        businessId,
        phase: "did_provisioning_failed",
        percent: 38,
        message: `DID provisioning failed: ${reason}. Assign manually from admin.`,
        source: "orchestrator",
        status: "error"
      });
    }
  }

  // Phase 3: build the deploy command with env injection. Unchanged; the
  // only difference is *how* we execute it (SSH instead of the fictional
  // Hostinger /exec endpoint).
  const gatewayToken = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  const bashQuote = deps?.quoteEnv ?? quoteShellEnvValue;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const progressUrl = `${appUrl.replace(/\/$/, "")}/api/provisioning/progress`;
  const progressToken = process.env.PROVISIONING_PROGRESS_TOKEN ?? process.env.ROWBOAT_GATEWAY_TOKEN ?? "";

  const envVars = [
    ["BUSINESS_ID", businessId],
    ["TIER", narrowTier],
    ["SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""],
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
    ["VOICE_BRIDGE_SRC", process.env.VOICE_BRIDGE_SRC ?? ""],
    ["CLOUDFLARE_TUNNEL_TOKEN", cloudflareTunnelToken],
    ["LIGHTPANDA_WSS_URL", process.env.LIGHTPANDA_WSS_URL ?? "wss://cdn.lightpanda.io/ws"],
    ["PROVISIONING_PROGRESS_URL", progressUrl],
    ["PROVISIONING_PROGRESS_TOKEN", progressToken]
  ]
    .map(([key, value]) => `${key}=${bashQuote(value)}`)
    .join(" ");

  await recordProvisioningProgress({
    businessId,
    phase: "remote_deploy_starting",
    percent: 40,
    message: "Running deploy-client.sh on VPS (SSH)",
    source: "orchestrator"
  });

  // Phase 4: SSH into the freshly-provisioned VPS and run deploy-client.sh.
  // The private key comes from `provisioned.sshKey.private_key_pem` — we
  // don't round-trip through the DB because we just wrote it and already
  // have it in memory.
  let deploySucceeded = false;
  try {
    const result = await remoteExec({
      host: provisioned.publicIp,
      username: provisioned.sshUsername,
      privateKeyPem: provisioned.sshKey.private_key_pem,
      command: `${envVars} /opt/deploy-client.sh`
    });
    if (result.exitCode !== 0) {
      logger.error("deploy-client.sh failed", {
        businessId,
        vpsId,
        exitCode: result.exitCode,
        stderr: result.stderr?.slice(0, 2000),
        stdout: result.stdout?.slice(0, 2000)
      });
      await recordProvisioningProgress({
        businessId,
        phase: "deploy_failed",
        percent: 95,
        message: `deploy-client.sh exit ${result.exitCode}: ${(result.stderr || result.stdout || "").slice(0, 2000)}`,
        source: "orchestrator",
        status: "error"
      });
    } else {
      deploySucceeded = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Remote deploy SSH failed — VPS may need manual setup", {
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
      await sendTelnyxSms(cfg, notifyPhone, `Your New Coworker is live! Dashboard: ${dashboardUrl}`);
    } catch (err) {
      logger.warn("Failed to send provisioning SMS", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { vpsId, tunnelUrl };
}
