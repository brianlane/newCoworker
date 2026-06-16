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
import {
  assertPlatformTelnyxDefaults,
  readPlatformTelnyxDefaults
} from "@/lib/telnyx/platform-defaults";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";
import { sendOwnerEmail } from "@/lib/email/client";
import { ensureTenantMailbox } from "@/lib/email/tenant-mailbox";
import { buildProvisioningLiveEmail } from "@/lib/email/templates/provisioning-live";
import { updateBusinessStatus, getBusiness } from "@/lib/db/businesses";
import { buildComplianceSystemPrompt } from "@/lib/compliance/fha";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";
import { readFileSync } from "fs";
import { join } from "path";
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
  /**
   * Hostinger billing subscription id (separate from the VM id). We persist
   * this on the `subscriptions` row so the lifecycle engine can cancel the
   * Hostinger-side billing when the user cancels their NewCoworker plan.
   * Null if Hostinger didn't return it (we couldn't reconcile via list).
   */
  hostingerBillingSubscriptionId: string | null;
};

function resolveStarterOrStandard(tier: ProvisioningInput["tier"]): "starter" | "standard" {
  if (tier === "enterprise") {
    const contact = process.env.CONTACT_EMAIL ?? "team@newcoworker.com";
    throw new Error(
      `Enterprise provisioning requires a custom engagement. Please contact ${contact} to discuss your needs.`
    );
  }
  return tier;
}

/**
 * Bootstrap soul.md used only when a business has no existing config yet (i.e.
 * pre-onboarding). The compliance guardrail is selected per business type so a
 * housing business gets Fair Housing Act language while every other industry
 * gets a neutral guardrail. Onboarding later regenerates soul.md via
 * `compileSoulMd`, which applies the same per-type rule.
 */
function loadSoulTemplate(businessType?: string | null): string {
  const compliance = buildComplianceSystemPrompt(businessType);
  try {
    const base = readFileSync(join(process.cwd(), "vps/templates/soul.md"), "utf-8").trimEnd();
    return `${base}\n\n## Compliance\n${compliance}\n`;
  } catch {
    return `# soul.md\nYou are a professional AI coworker.\n\n## Compliance\n${compliance}\n`;
  }
}

function loadIdentityTemplate(): string {
  try {
    return readFileSync(join(process.cwd(), "vps/templates/identity.md"), "utf-8");
  } catch {
    return "# identity.md\nBusiness Name: {{business_name}}";
  }
}

/**
 * Single-quote `value` for bash, escaping any embedded `'` with the canonical
 * `'\''` end-quote / escape / start-quote sequence. Functionally equivalent to
 * `bash printf %q` for the kinds of values this orchestrator passes (opaque
 * tokens / URLs / JWTs / ids), and works on every platform without requiring
 * a `bash` binary on $PATH.
 *
 * Previously this used `spawnSync("bash", ["-c", 'printf %q "$1"', ...])`.
 * The orchestrator's deploy-env builder calls this once per env var (≈26
 * vars), and on macOS each `bash` spawn costs ~80–100 ms (xprotect / dyld /
 * amfi), so the deploy phase paid ~2.5 s of pure subprocess overhead per
 * call — which compounded across the ~30 orchestrator tests that exercise
 * this path and made the local `vitest run` suite take ~4 minutes vs ~45 s
 * on Linux CI. The pure-JS path produces a bash-equivalent quoted form, so
 * dropping the spawn fixes the macOS-vs-CI divergence without changing the
 * shell-side semantics on the VPS.
 */
export function quoteShellEnvValue(value: string): string {
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
 * Build the SSH command that stages and runs the bootstrap script.
 *
 * The leading `cloud-init status --wait` is critical for the PIS-attached
 * path: when Hostinger executes the post-install-script via cloud-init,
 * its `runcmd` phase holds `/var/lib/dpkg/lock-frontend` AND `/var/lib/
 * apt/lists/lock` for the duration of the bootstrap (apt-get update,
 * Docker install, etc.). The orchestrator's SSH-bootstrap pass starts as
 * soon as sshd binds — which can be well before cloud-init's runcmd
 * finishes — and our `apt-get install -y --no-install-recommends git
 * curl ca-certificates` would race the in-flight cloud-init apt and exit
 * non-zero under `set -euo pipefail`, aborting the whole provision.
 *
 * `cloud-init status --wait` blocks (idempotent) until cloud-init signals
 * `done`. On hosts where cloud-init isn't installed or has already
 * finished the call exits ≤2s. The `2>/dev/null || true` belt-and-braces
 * keeps it non-fatal on minimal templates that lack the binary entirely.
 *
 * Belt-and-braces: the slim loader script itself ALSO passes
 * `-o DPkg::Lock::Timeout=300` (see `buildDefaultPostInstallScript` in
 * src/lib/hostinger/provision.ts) so even if a cloud-init module finishes
 * after this wait returns and re-grabs the lock, apt-get blocks for up
 * to 5 minutes instead of failing immediately.
 */
function buildBootstrapSshCommand(bootstrapB64: string): string {
  return (
    `cloud-init status --wait 2>/dev/null || true; ` +
    `printf '%s' '${bootstrapB64}' ` +
    `| base64 -d > /tmp/newcoworker-bootstrap.sh ` +
    `&& chmod +x /tmp/newcoworker-bootstrap.sh ` +
    `&& bash /tmp/newcoworker-bootstrap.sh`
  );
}

/**
 * Run the bootstrap script on an already-provisioned VPS over SSH.
 *
 * Internal-only — the only production caller is the orchestrator's own
 * bootstrap phase below. A previously-exported `runRemoteBootstrap`
 * wrapper that returned 2KB tails was dropped (per Cursor Bugbot Low
 * "wire-or-drop" guidance) when the customer-specific oneshot that
 * consumed it was deleted; future admin UIs can call this directly,
 * or re-introduce a thin tail-capping wrapper at that time.
 *
 * Returns the FULL `SshExecResult` so the orchestrator can:
 *   - dump the tail into `coworker_logs` on a non-zero exit (operators
 *     debugging a partial bootstrap want the actual error, not just
 *     the last 2KB after a wall of progress lines), and
 *   - feed the trimmed tail back into the thrown Error message so the
 *     top-level `failed` row in coworker_logs carries something
 *     actionable.
 */
async function runRemoteBootstrapInternal(input: {
  host: string;
  username: string;
  privateKeyPem: string;
  tier: "starter" | "standard";
  remoteExec: RemoteExecutor;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SshExecResult> {
  const script = buildDefaultPostInstallScript({ tier: input.tier });
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const cmd = buildBootstrapSshCommand(b64);
  return runWithSshConnectRetry(
    () =>
      input.remoteExec({
        host: input.host,
        username: input.username,
        privateKeyPem: input.privateKeyPem,
        command: cmd
      }),
    input.sleep ? { sleep: input.sleep } : undefined
  );
}

/**
 * Wrap a single SSH-exec attempt in a retry loop that ONLY retries on
 * "connection failed" (refused / handshake timeout / kex failure). Once the
 * remote command has actually run, its exit code is the source of truth and
 * we don't retry — re-running a partial bootstrap is more dangerous than
 * surfacing the error.
 *
 * The fresh-VPS race we're catching: Hostinger flips `state=running` as
 * soon as cloud-init signals success, but sshd's listener can lag by 5-30s
 * while the OS finishes binding port 22. Without a retry, the orchestrator
 * sees `ECONNREFUSED` on the first try and fails the whole provision.
 */
export async function runWithSshConnectRetry<T>(
  attempt: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 6;
  const baseDelayMs = opts?.baseDelayMs ?? 5000;
  /* c8 ignore next -- production default; tests inject sleep */
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (!isSshConnectError(err) || i === maxAttempts - 1) {
        throw err;
      }
      // Linear backoff (5s, 10s, 15s, ...). Total worst-case wait at default
      // settings is 5+10+15+20+25 = 75s before the final attempt — well under
      // any practical sshd-startup window we've observed.
      await sleep(baseDelayMs * (i + 1));
    }
  }
  /* c8 ignore next 2 -- unreachable: loop above either returns or throws */
  throw lastErr;
}

function isSshConnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("connection error") ||
    m.includes("connection refused") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("timed out") ||
    m.includes("handshake")
  );
}

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
        // Attempt to attach the bootstrap as Hostinger's first-boot
        // post-install script. provisionVpsForBusiness gracefully degrades
        // on the 403 chicken-and-egg ("account doesn't yet own a VPS") so
        // the SSH-bootstrap phase below always runs the same content
        // afterward. Either path produces the same state because the
        // script is idempotent.
        postInstallScript: buildDefaultPostInstallScript({ tier })
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
    /**
     * Test-injectable sleep used by the SSH-bootstrap connect-retry loop.
     * Production uses `setTimeout`; tests inject a no-op so retry assertions
     * run without burning real wall-clock time.
     */
    sleep?: (ms: number) => Promise<void>;
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

  try {
    return await runOrchestrator({ businessId, ownerEmail, ownerPhone, tier: narrowTier }, deps);
  } catch (err) {
    // Top-level safety net. Several inner steps already record their own
    // `status: "error"` rows AND swallow the error (cloudflare, DID, deploy),
    // but the calls before the cloudflare phase — `vpsProvisioner`,
    // `updateBusinessStatus`, the config writes — are unprotected, so a
    // Hostinger 4xx (e.g. token missing the `post-install-scripts` scope,
    // retired data-center id, suspended payment method) used to bubble
    // straight up to the webhook caller. The dashboard, which polls
    // `coworker_logs` for the latest provisioning row, would then sit on
    // the 5%/`started` row indefinitely with no actionable feedback.
    //
    // Recording a terminal `failed` row here flips the dashboard widget into
    // its error state via `shouldMountProvisioningWidget` and gives the
    // owner something concrete to show support. We then re-throw so the
    // caller can still log + propagate failure to its own callers.
    const detail = describeProvisioningError(err);
    logger.error("Provisioning failed", {
      businessId,
      ...detail
    });
    try {
      await recordProvisioningProgress({
        businessId,
        phase: "failed",
        percent: 5,
        message: formatProvisioningErrorMessage(detail),
        source: "orchestrator",
        status: "error"
      });
    } catch (logErr) {
      // Logging the failure must never mask the original error. If the
      // coworker_logs insert itself fails (DB outage, RLS misconfig) we
      // surface that as a warn so the operator can investigate, but the
      // outer `throw` below is what the caller sees.
      logger.warn("Failed to record provisioning failure row", {
        businessId,
        error: logErr instanceof Error ? logErr.message : String(logErr)
      });
    }
    throw err;
  }
}

/**
 * Structured detail extracted from a thrown provisioning error.
 *
 * Hostinger API failures carry endpoint + status + raw response body that
 * are essential for diagnosing scope/permission/SKU drift problems
 * (e.g. `[VPS:2000] Unauthorized` from a token missing the
 * `post-install-scripts` scope). The plain `err.message` strips all of
 * that. By inspecting `err.name === "HostingerApiError"` instead of
 * importing the class we keep this module decoupled from the Hostinger
 * client (and avoid an import cycle with the test-injected provisioner).
 */
type ProvisioningErrorDetail = {
  message: string;
  endpoint?: string;
  status?: number;
  body?: unknown;
};

/**
 * Stringify a thrown value from the 10DLC attach call.
 *
 * Pulled into a tiny helper so v8 can instrument the Error vs non-Error
 * branches without a synthetic uninstrumented arm — when this lived
 * inline as `err instanceof Error ? err.message : String(err)`, v8
 * couldn't see the falsy arm under TS source maps and reported partial
 * coverage on the catch line.
 */
export function describeAttachError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build the user-facing progress copy for the 10DLC attach phase.
 *
 * Pulled out of the orchestrator body because (a) v8 was missing branch
 * coverage on the inline ternary, and (b) when the marketing/support
 * team inevitably wants to tweak the wording it should be one focused
 * change with regression tests, not a 600-line file edit.
 *
 * `registered` is the only status that drops `status: undefined` so the
 * progress UI can advance the phase indicator. Every other outcome
 * stays in `thinking` because the retry worker still has work to do.
 */
export function formatTendlcAttachProgress(
  outcome: { kind: "registered" | "pending" | "rejected" | "error"; reason?: string },
  toE164: string
): { message: string; status: "thinking" | undefined } {
  if (outcome.kind === "registered") {
    return {
      message: `SMS 10DLC registered (${toE164})`,
      status: undefined
    };
  }
  const reason = outcome.reason ?? "unknown";
  if (outcome.kind === "pending") {
    return {
      message: `SMS 10DLC queued (carrier vetting): ${reason}`,
      status: "thinking"
    };
  }
  if (outcome.kind === "rejected") {
    return {
      message: `SMS 10DLC rejected: ${reason}. Retrying via worker.`,
      status: "thinking"
    };
  }
  return {
    message: `SMS 10DLC transient failure: ${reason}. Retrying via worker.`,
    status: "thinking"
  };
}

export function describeProvisioningError(err: unknown): ProvisioningErrorDetail {
  if (err instanceof Error && err.name === "HostingerApiError") {
    const e = err as Error & { endpoint?: unknown; status?: unknown; body?: unknown };
    return {
      message: err.message,
      endpoint: typeof e.endpoint === "string" ? e.endpoint : undefined,
      status: typeof e.status === "number" ? e.status : undefined,
      body: e.body
    };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function formatProvisioningErrorMessage(detail: ProvisioningErrorDetail): string {
  if (detail.endpoint && typeof detail.status === "number") {
    return `Provisioning failed: Hostinger ${detail.endpoint} → HTTP ${detail.status} (${detail.message})`;
  }
  return `Provisioning failed: ${detail.message}`;
}

async function runOrchestrator(
  input: ProvisioningInput & { tier: "starter" | "standard" },
  deps?: Parameters<typeof orchestrateProvisioning>[1]
): Promise<ProvisioningResult> {
  const { businessId, ownerEmail, ownerPhone, tier: narrowTier } = input;

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

  // Phase 1b: SSH-bootstrap the VPS.
  //
  // This phase ALWAYS runs, regardless of whether `provisionVpsForBusiness`
  // managed to attach the same content as a Hostinger first-boot script
  // (see `provisioned.postInstallScriptId`). Two reasons:
  //
  //   1. Belt-and-suspenders for fresh accounts: PIS attach 403s on
  //      accounts that don't already own a VPS. Without this fallback,
  //      first-time provisions would never get past `running`.
  //   2. Idempotent re-runs: when PIS *did* attach + complete, this SSH
  //      pass is a quick \`git fetch\` + idempotent \`bash bootstrap.sh\`
  //      verification. When it *didn't*, this pass is the only bootstrap.
  //
  // The script content is the slim loader from
  // `buildDefaultPostInstallScript({ tier })`; it clones the repo, drops
  // /opt/deploy-client.sh, and exec's the FULL `vps/scripts/bootstrap.sh`
  // (system hardening, Docker, Ollama, Rowboat compose, cloudflared
  // install). Failure here is fatal: the deploy phase below needs
  // /opt/deploy-client.sh AND a healthy Rowboat stack to even start, so we
  // re-use the orchestrator's top-level `failed` recorder via \`throw\`.
  const bootstrapMessage = provisioned.postInstallScriptId
    ? `Verifying VPS bootstrap over SSH (Hostinger PIS attached, id=${provisioned.postInstallScriptId})`
    : "Bootstrapping VPS over SSH (PIS not eligible — running full bootstrap)";

  await recordProvisioningProgress({
    businessId,
    phase: "vps_bootstrapping",
    percent: 17,
    message: bootstrapMessage,
    source: "orchestrator"
  });

  // Single-source-of-truth bootstrap invocation via
  // `runRemoteBootstrapInternal`, which encapsulates the script
  // construction (`buildBootstrapSshCommand` + `buildDefaultPostInstallScript`)
  // and the sshd connect-retry loop. Returns the full SshExecResult so we
  // can persist a non-truncated tail to coworker_logs on failure (see the
  // helper's docstring for why the orchestrator path needs the full
  // streams instead of a 2KB tail).
  const bootstrapResult = await runRemoteBootstrapInternal({
    host: provisioned.publicIp,
    username: provisioned.sshUsername,
    privateKeyPem: provisioned.sshKey.private_key_pem,
    tier: narrowTier,
    remoteExec,
    sleep: deps?.sleep
  });

  if (bootstrapResult.exitCode !== 0) {
    const tail = (bootstrapResult.stderr || bootstrapResult.stdout || "").slice(-2000);
    logger.error("VPS bootstrap failed", {
      businessId,
      vpsId,
      exitCode: bootstrapResult.exitCode,
      tail
    });
    throw new Error(
      `VPS bootstrap failed (exit ${bootstrapResult.exitCode}): ${tail || "<no output>"}`
    );
  }

  await recordProvisioningProgress({
    businessId,
    phase: "vps_bootstrapped",
    percent: 22,
    message: provisioned.postInstallScriptId
      ? `VPS bootstrap verified (Hostinger PIS id=${provisioned.postInstallScriptId} + SSH re-run)`
      : "VPS bootstrap complete (SSH-only fallback path)",
    source: "orchestrator"
  });

  await updateBusinessStatus(businessId, "offline", vpsId);

  const existingConfig = await getBusinessConfig(businessId);
  const businessRow = await getBusiness(businessId);
  await upsertBusinessConfig({
    business_id: businessId,
    soul_md: existingConfig?.soul_md ?? loadSoulTemplate(businessRow?.business_type),
    identity_md: existingConfig?.identity_md ?? loadIdentityTemplate(),
    memory_md: existingConfig?.memory_md ?? "# memory.md\nLossless memory DAG initialized.",
    // Preserve the onboarding website crawl. Without this the upsert defaults
    // `website_md` to "" and wipes the content every time we re-provision.
    website_md: existingConfig?.website_md ?? ""
  });

  await recordProvisioningProgress({
    businessId,
    phase: "config_upserted",
    percent: 25,
    message: "Business config written to Supabase",
    source: "orchestrator"
  });

  // Reserve the AI coworker's dedicated mailbox (default = the business UUID;
  // standard/enterprise can personalize later from Settings). Idempotent and
  // best-effort: it's just a DB row (Cloudflare Email Routing's catch-all
  // already routes every address), so a transient failure here must never
  // abort the deploy — the dashboard's mailbox route also self-heals via
  // ensureTenantMailbox on first read.
  try {
    const mailbox = await ensureTenantMailbox(businessId);
    await recordProvisioningProgress({
      businessId,
      phase: "mailbox_reserved",
      percent: 26,
      message: `AI mailbox reserved (${mailbox.local_part})`,
      source: "orchestrator"
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Tenant mailbox reservation failed (non-fatal)", { businessId, error: msg });
  }

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

  // Fallback hostname only used when the tunnel provisioner is disabled
  // (no CF token in env, dep injected as `null`). The leading subdomain
  // is the business UUID — ONE level under the zone — so Universal SSL
  // on the parent zone covers it without paid Total TLS.
  //
  // We coerce blank/whitespace strings to `undefined` BEFORE the `??` because
  // dotenv parses lines like `CLOUDFLARE_TUNNEL_ZONE=` (the form documented in
  // `.env.example`) as the empty string, which `??` treats as defined and would
  // produce the malformed hostname `"<biz>."`. This matches the same blank-coerce
  // pattern used by `cloudflareTunnelProvisionerFromEnv` in `lib/cloudflare/tunnel.ts`.
  const rawTunnelZone = process.env.CLOUDFLARE_TUNNEL_ZONE;
  const tunnelZone =
    typeof rawTunnelZone === "string" && rawTunnelZone.trim().length > 0
      ? rawTunnelZone.trim()
      : "newcoworker.com";
  let tunnelHostname = `${businessId}.${tunnelZone}`;
  let cloudflareTunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
  let bridgeMediaWssOrigin = process.env.BRIDGE_MEDIA_WSS_ORIGIN ?? "";
  // The AiFlow render sidecar (headless Chromium) is only deployed on
  // render-capable tiers — never the starter/KVM2 box, which is already
  // memory-constrained by Ollama + Rowboat. Gate the public render hostname to
  // match where the container actually runs.
  const renderEnabled = narrowTier !== "starter";
  if (tunnelProvisioner) {
    try {
      const p = await tunnelProvisioner({ businessId, renderEnabled });
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
        // Hard-stop before placing a real number order if the platform
        // doesn't have a Call Control connection_id and/or messaging
        // profile id. Ordering without these silently produces an
        // unwired DID that costs money and can't carry calls (root
        // cause of the May 2026 "call could not be completed" outage
        // — number was active in Telnyx, but `connection_id: ""` left
        // inbound webhooks with nowhere to go). Failing here surfaces
        // the config gap as a deploy-time error instead of a silent
        // production regression at first call.
        assertPlatformTelnyxDefaults(platformDefaults);
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

        // Best-effort 10DLC (A2P SMS) campaign attach. US carriers silently
        // drop A2P SMS from numbers that aren't registered to an approved
        // campaign — the May 2026 SMS outage was exactly this. If 10DLC
        // isn't configured yet, or the shared campaign is still in carrier
        // vetting, we record the per-DID status as `pending` and let the
        // dashboard banner + retry worker pick it up later. NEVER block
        // provisioning on this — the customer's voice + inbound-SMS path
        // works without it.
        try {
          const { attachBusinessDidToCampaign } = await import(
            "@/lib/provisioning/tendlc-attach"
          );
          const outcome = await attachBusinessDidToCampaign({
            businessId,
            toE164
          });
          const progress = formatTendlcAttachProgress(outcome, toE164);
          await recordProvisioningProgress({
            businessId,
            phase: "did_10dlc_attach",
            percent: 39,
            message: progress.message,
            source: "orchestrator",
            // Always "thinking" for non-registered: a pending/rejected DID
            // doesn't fail the orchestrator (voice + inbound SMS still
            // work) and the retry worker handles the rest.
            status: progress.status
          });
        } catch (err) {
          // Including MissingTendlcConfigError — surfaces in progress log
          // but doesn't fail the orchestrator.
          const reason = describeAttachError(err);
          logger.warn("10DLC attach skipped", { businessId, reason });
          await recordProvisioningProgress({
            businessId,
            phase: "did_10dlc_attach",
            percent: 39,
            message: `SMS 10DLC attach skipped: ${reason}. Will retry.`,
            source: "orchestrator",
            status: "thinking"
          });
        }
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
    // Rollout flag for Gemini Live transcript capture. Read by the voice
    // bridge (vps/voice-bridge/src/index.ts); when "true" it attaches the
    // Supabase transcript adapter and persists caller/assistant turn rows
    // into voice_call_transcript_turns. Default-off so tenants opt in by
    // setting the var on Vercel and re-running provisioning.
    ["VOICE_TRANSCRIPTION_ENABLED", process.env.VOICE_TRANSCRIPTION_ENABLED ?? ""],
    // Model name Rowboat uses for the voice_task agent via the llm-router
    // sidecar. Falls back to the deploy-client.sh default when unset.
    ["GEMINI_ROWBOAT_MODEL", process.env.GEMINI_ROWBOAT_MODEL ?? ""],
    // Model Rowboat's OwnerCoworker (owner dashboard chat) agent uses via the
    // llm-router. Mirrors GEMINI_ROWBOAT_MODEL so setting it on Vercel actually
    // reaches the VPS seed; blank lets deploy-client.sh apply its default
    // (gemini-2.5-flash-lite, which itself falls back to local without a key).
    ["OWNER_CHAT_MODEL", process.env.OWNER_CHAT_MODEL ?? ""],
    // Public origin of the platform app so Rowboat's voice_task agent and
    // the voice-bridge tool dispatcher can POST to /api/voice/tools/* with
    // the shared gateway token. Falls back to NEXT_PUBLIC_APP_URL so local
    // and preview deployments work without a separate knob.
    ["APP_BASE_URL", process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? ""],
    ["VOICE_BRIDGE_SRC", process.env.VOICE_BRIDGE_SRC ?? ""],
    // Shared bearer the ai-flow-worker (Supabase Edge) sends to this tenant's
    // render sidecar. deploy-client.sh only stands the sidecar up on non-starter
    // tiers; the render→platform credential lookup reuses APP_BASE_URL +
    // ROWBOAT_GATEWAY_TOKEN, so only this one extra secret needs to flow here.
    ["AIFLOW_RENDER_TOKEN", process.env.AIFLOW_RENDER_TOKEN ?? ""],
    ["CLOUDFLARE_TUNNEL_TOKEN", cloudflareTunnelToken],
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
  const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const dashboardUrl = `${siteUrl}/dashboard`;

  if (notifyEmail) {
    try {
      const { subject, text, html } = buildProvisioningLiveEmail({
        dashboardUrl,
        siteUrl,
        recipientEmail: notifyEmail
      });
      await sendOwnerEmail(process.env.RESEND_API_KEY ?? "", notifyEmail, subject, { text, html });
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

  return {
    vpsId,
    tunnelUrl,
    hostingerBillingSubscriptionId: provisioned.hostingerBillingSubscriptionId
  };
}
