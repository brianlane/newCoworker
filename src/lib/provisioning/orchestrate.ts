import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import {
  provisionVpsForBusiness,
  buildDefaultPostInstallScript,
  chargedVirtualMachineId,
  type ProvisionVpsForBusinessResult
} from "@/lib/hostinger/provision";
import { adoptVpsForBusiness } from "@/lib/hostinger/adopt";
import { resolvePaidThroughForBillingSub } from "@/lib/hostinger/paid-through";
import {
  claimAvailableVps,
  countAssignedVpsForBusiness,
  claimSpecificAvailableVps,
  listVpsInventory,
  recordVpsAssigned,
  releaseVpsToPool,
  retireVps
} from "@/lib/db/vps-inventory";
import {
  reconcileOrphanedPurchases,
  reconcileUntilSizeMatch,
  orphanMatchesPurchaseAttempt,
  type ReconciledOrphan
} from "@/lib/provisioning/reconcile-orphans";
import { cleanupStaleTenantsForVm } from "@/lib/provisioning/stale-tenant-cleanup";
import { sshExec, type SshExecResult } from "@/lib/hostinger/ssh";
import { sshExecPinned, type HostKeyPinnable } from "@/lib/hostinger/ssh-pinned";
import { sendTelnyxSms, getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";
import { TelnyxNumbersClient } from "@/lib/telnyx/numbers";
import {
  orderAndAssignDidForBusiness,
  OrderAndAssignError,
  coerceOwnerPhoneToE164,
  extractNanpAreaCode,
  type PlatformTelnyxDefaults
} from "@/lib/telnyx/assign-did";
import {
  buildDidSearchPlan,
  normalizePreferredAreaCode,
  type DidSearchSpec
} from "@/lib/telnyx/did-search-plan";
import {
  assertPlatformTelnyxDefaults,
  readPlatformTelnyxDefaults
} from "@/lib/telnyx/platform-defaults";
import {
  getBusinessTelnyxSettings,
  getTelnyxVoiceRouteForBusiness,
  upsertBusinessTelnyxSettings
} from "@/lib/db/telnyx-routes";
import {
  TelnyxVoiceInfraClient,
  ensureTenantVoiceInfra,
  resolveTenantMaxConcurrentCalls,
  voiceDispatchWebhookUrl
} from "@/lib/telnyx/tenant-voice-infra";
import { sendOwnerEmail } from "@/lib/email/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { ensureTenantMailbox } from "@/lib/email/tenant-mailbox";
import { buildProvisioningLiveEmail } from "@/lib/email/templates/provisioning-live";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { sendOpsDeployFailedEmail, sendOpsNewSignupEmail } from "@/lib/email/ops-notify";
import { getSubscription, persistHostingerBillingIdOnLiveSubscription } from "@/lib/db/subscriptions";
import { updateBusinessStatus, updateBusinessVpsSize, getBusiness } from "@/lib/db/businesses";
import { resolveOwnerNotifyEmail } from "@/lib/provisioning/notify-recipient";
import { resolveBusinessCountry } from "@/lib/plans/business-country";
import {
  getActiveGatewayTokenForBusiness,
  issueGatewayToken,
  listActiveGatewayTokensForBusiness,
  markGatewayTokenDeployed
} from "@/lib/db/vps-gateway-tokens";
import { resolveResidencyBackupPassphraseForDeploy } from "@/lib/residency/backup-keys";
import { assertResidencyForPlacement } from "@/lib/residency/enforce";
import { assertHipaaPlacement } from "@/lib/hipaa/placement";
import { buildComplianceSystemPrompt } from "@/lib/compliance/fha";
import {
  parseComplianceModule,
  renderComplianceModuleSection,
  type ComplianceModule
} from "@/lib/compliance/module";
import { parseEnterpriseModels } from "@/lib/plans/enterprise-models";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { logger } from "@/lib/logger";
import { readFileSync } from "fs";
import { join } from "path";
import {
  recordProvisioningProgress,
  hasPriorOpsNewSignupAlert,
  getLatestProvisioningStatus,
  type LatestProvisioningStatus
} from "@/lib/provisioning/progress";
import {
  cloudflareTunnelProvisionerFromEnv,
  type CloudflareTunnelProvisioner
} from "@/lib/cloudflare/tunnel";
import { resolveVpsSize, type VpsSize } from "@/lib/vps/size";
import { sharedHardwareFor, sharedHardwareWarning } from "@/lib/vps/shared-hardware";
import {
  assertVpsProviderAllowed,
  providerUsesHostingerLifecycle,
  resolveVpsProvider,
  type VpsProvider
} from "@/lib/vps/provider";
import {
  DEFAULT_PURCHASE_TERM,
  type HostingerBillingTerm
} from "@/lib/hostinger/provision";
import type { BillingPeriod } from "@/lib/plans/tier";

type ProvisioningInput = {
  businessId: string;
  tier: "starter" | "standard" | "enterprise";
  /**
   * Hardware pin (`businesses.vps_size`). Callers pass the raw column value;
   * null/undefined resolves to the tier default (starter→kvm1,
   * standard→kvm2, enterprise→kvm8, see DEFAULT_TIER_VPS_SIZE). Drives the
   * Hostinger SKU + bootstrap hardware profile only, entitlements stay on
   * `tier`.
   */
  vpsSize?: string | null;
  /**
   * Customer contract term. When a purchase is needed, the Hostinger box is
   * bought at the matching term (biennial → 2-year SKU, annual → 1-year),
   * term SKUs are ~40-65% cheaper per month than monthly renewal. Omitted /
   * null buys monthly. Pool adoption ignores this (the box is already owned).
   */
  billingPeriod?: BillingPeriod | null;
  /**
   * Explicit Hostinger purchase term. Overrides the `billingPeriod`
   * derivation so a signup can buy monthly hardware for a contract customer
   * and the contract-upgrade sweep can buy exactly the shortfall term.
   */
  hostingerTerm?: HostingerBillingTerm | null;
  /**
   * Skip the adopt-first pool claim and force a purchase. Used by the
   * change-plan term-alignment migration, whose entire point is landing on
   * a term-priced PURCHASE, adopting a pooled (typically monthly-cycle,
   * soon-lapsing) box there would keep the tenant on expensive renewal
   * pricing. The purchased box is still recorded in `vps_inventory`.
   */
  skipPoolAdopt?: boolean;
  ownerEmail?: string;
  ownerPhone?: string;
  /**
   * When true, skip the owner "Your New Coworker is live!" email and SMS.
   * Used by background hardware migrations (term-renewal sweep, size migrate)
   * so an existing customer is not texted as if they just signed up. Ops
   * emails are unaffected. New signups and change-plan leave this unset.
   */
  suppressOwnerNotify?: boolean;
  /**
   * `Date.now()` at the moment the caller's route budget started.
   *
   * Migrations pass this so the deploy poll gets what is LEFT of the 1800s
   * route budget rather than a flat 28 minutes. It is a timestamp and not a
   * precomputed duration on purpose: the orchestrator still has to purchase,
   * boot and SSH-bootstrap before the poll begins, so the remaining budget can
   * only be computed correctly at the poll itself.
   *
   * Omitted for signup, which gets {@link DEPLOY_CLIENT_DEADLINE_DEFAULT_MS}.
   */
  deployBudgetStartedAtMs?: number;
  /** When true, send the ops "[ops] New signup live" alert after first successful deploy. */
  notifyOpsNewSignup?: boolean;
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
  /**
   * False when deploy-client.sh did not finish cleanly (non-zero exit, SSH
   * exception, or the phase-4 deadline elapsing while it was still running).
   *
   * The box is still returned, and the business is still flipped back to
   * "online", because a signup on a half-deployed box is recoverable and the
   * owner keeps their row. Migrations are the opposite: they must NOT cut over
   * onto a box with no working stack, because the next steps stop the old VM
   * and disable its auto-renewal. Callers that tear down a healthy old box
   * have to check this.
   */
  deploySucceeded: boolean;
};

/**
 * Map the ENTITLEMENT tier onto the on-box deploy profile. Enterprise runs
 * the STANDARD box profile (full compose stack, render sidecar, standard
 * Ollama model selection), there is no separate enterprise bootstrap TIER,
 * and every downstream gate already treats enterprise as standard-plus
 * (render, analytics, call summaries, BYON). Entitlements (limits, caps,
 * `enterprise_limits` overrides) keep reading the REAL tier from the
 * `businesses` row; only the hardware/deploy axis narrows here. Hardware
 * defaults come from `resolveVpsSize` (enterprise → kvm8, admin-pinnable).
 */
function resolveBoxTier(tier: ProvisioningInput["tier"]): "starter" | "standard" {
  return tier === "starter" ? "starter" : "standard";
}

/**
 * Bootstrap soul.md used only when a business has no existing config yet (i.e.
 * pre-onboarding). The compliance guardrail is selected per business type so a
 * housing business gets Fair Housing Act language while every other industry
 * gets a neutral guardrail. Onboarding later regenerates soul.md via
 * `compileSoulMd`, which applies the same per-type rule.
 */
function loadSoulTemplate(
  businessType?: string | null,
  complianceModule?: ComplianceModule | null
): string {
  const compliance = buildComplianceSystemPrompt(businessType);
  // Enterprise custom compliance module (additive, marker-delimited) so a
  // fresh provision bakes it in; later admin edits rewrite the same block
  // through /api/admin/compliance-module + vault sync.
  const customSection = complianceModule
    ? `\n\n${renderComplianceModuleSection(complianceModule)}`
    : "";
  try {
    const base = readFileSync(join(process.cwd(), "vps/templates/soul.md"), "utf-8").trimEnd();
    return `${base}\n\n## Compliance\n${compliance}${customSection}\n`;
  } catch {
    return `# soul.md\nYou are a professional AI coworker.\n\n## Compliance\n${compliance}${customSection}\n`;
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
 * call, which compounded across the ~30 orchestrator tests that exercise
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
  /**
   * Tenant key row for host-key pinning (G7). When present, the production
   * executor verifies strictly against the row's recorded fingerprint (or
   * captures it on first connect). Injected test executors may ignore it.
   */
  sshKeyRow?: HostKeyPinnable;
}) => Promise<SshExecResult>;

/* c8 ignore start -- production-only default; tests inject remoteExec */
const defaultRemoteExecutor: RemoteExecutor = (args) =>
  args.sshKeyRow
    ? sshExecPinned(args.sshKeyRow, {
        host: args.host,
        username: args.username,
        privateKeyPem: args.privateKeyPem,
        command: args.command
      })
    : sshExec({
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
 * soon as sshd binds, which can be well before cloud-init's runcmd
 * finishes, and our `apt-get install -y --no-install-recommends git
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
 * Internal-only, the only production caller is the orchestrator's own
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
  vpsSize: VpsSize;
  remoteExec: RemoteExecutor;
  /** Key row for host-key pinning (captured on this first connect). */
  sshKeyRow?: HostKeyPinnable;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SshExecResult> {
  const script = buildDefaultPostInstallScript({ tier: input.tier, vpsSize: input.vpsSize });
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const cmd = buildBootstrapSshCommand(b64);
  return runWithSshConnectRetry(
    () =>
      input.remoteExec({
        host: input.host,
        username: input.username,
        privateKeyPem: input.privateKeyPem,
        command: cmd,
        sshKeyRow: input.sshKeyRow
      }),
    input.sleep ? { sleep: input.sleep } : undefined
  );
}

/**
 * Wrap a single SSH-exec attempt in a retry loop that ONLY retries on
 * "connection failed" (refused / handshake timeout / kex failure). Once the
 * remote command has actually run, its exit code is the source of truth and
 * we don't retry, re-running a partial bootstrap is more dangerous than
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
      // settings is 5+10+15+20+25 = 75s before the final attempt, well under
      // any practical sshd-startup window we've observed.
      await sleep(baseDelayMs * (i + 1));
    }
  }
  /* c8 ignore next 2 -- unreachable: loop above either returns or throws */
  throw lastErr;
}

/**
 * Probe for "the box's own post-install run has finished". Greps for the
 * loader's long-lived `tee -a /post_install.log` plus apt/apt-get/dpkg. The
 * `[e]` character class stops `pgrep -f` from matching this probe's own
 * command line, which contains the literal pattern. Bare `apt` is matched as
 * well as `apt-get`: Hostinger's own maintenance runs `apt`.
 *
 * Copied deliberately from `adopt.ts`'s `defaultPisQuiescentProbe` rather
 * than shared, because the two live on opposite sides of the
 * provisioning/hostinger module boundary and adopt owns its own SSH stack.
 * If a third caller appears, hoist it.
 */
const PIS_QUIESCENCE_PROBE_COMMAND =
  "if pgrep -f 'te[e] -a /post_install.log' >/dev/null || pgrep -x apt >/dev/null || " +
  "pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null; then echo busy; else echo idle; fi";

/**
 * How long to wait for Hostinger's own post-install runner before bootstrapping
 * anyway.
 *
 * Measured, not guessed: on KIN's box (VM 1936826, 2026-08-28) the loader ran
 * 15:53:13 to 15:54:22, so the whole first-boot bootstrap is about 70 seconds.
 * Ten minutes is roughly eight times that, and still leaves the term-renewal
 * sweep's 1800s route budget most of its room. Adopt allows 25 minutes, but
 * adopt runs from a debug script with no route deadline over it.
 */
const PIS_QUIESCENCE_TIMEOUT_MS = 10 * 60 * 1000;

/** Gap between probes. Adopt uses the same 15s. */
const DEFAULT_QUIESCENCE_POLL_MS = 15_000;

/**
 * How long to tolerate SSH auth rejections before concluding the key is not
 * coming.
 *
 * This wait only runs when a post-install script is attached, and that script
 * is now what WRITES the key (see `buildDefaultPostInstallScript`). So an auth
 * rejection early in the run is the expected transient: sshd is up, the
 * runner has not reached the authorized_keys line yet. Treating it as
 * permanent would exit the wait exactly on the boxes that depend on the PIS
 * write, which is to say exactly when Hostinger dropped `public_key_ids`,
 * which is the case this whole change exists for.
 *
 * Three minutes is generous against a key written in the first seconds of the
 * run, and still bounds the genuinely keyless box (PIS never ran AND
 * `public_key_ids` dropped) well under the full quiescence budget. After it,
 * the bootstrap raises the real error within its own 76s retry.
 */
const AUTH_GRACE_MS = 3 * 60 * 1000;

/**
 * Real timers, named so they are ordinary covered code rather than an
 * inline default hidden behind a `c8 ignore`. An ignored default is an
 * untested default, and this pair decides how long a provision waits.
 */
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const defaultNow = (): number => Date.now();

/**
 * Wait for the box's own post-install script to go quiescent before the
 * orchestrator SSHes in and runs the same bootstrap.
 *
 * Hostinger executes an attached post-install script through ITS OWN runner,
 * not cloud-init, so the `cloud-init status --wait` that
 * `buildBootstrapSshCommand` prefixes cannot see it. Without this wait the two
 * copies overlap. Measured on the purchase path: Hostinger reported VM 1939337
 * running 103s after create and the orchestrator SSHed in one second later,
 * against a first-boot bootstrap that takes about 70s from boot. The loader's
 * own `wait_for_apt` covers the apt half of that overlap, but nothing
 * serialises two concurrent runs of `bootstrap.sh` itself (Docker, Ollama,
 * Rowboat compose, systemd units). `adopt.ts` has waited here since it was
 * written; the purchase path never did, because until #1696 no purchase ever
 * got far enough to find out.
 *
 * Returns why it stopped, so the caller can log it. Never throws: every
 * outcome hands control to the bootstrap phase, which is the step allowed to
 * fail the provision.
 */
export async function waitForPostInstallQuiescence(input: {
  host: string;
  username: string;
  privateKeyPem: string;
  sshKeyRow?: HostKeyPinnable;
  remoteExec: RemoteExecutor;
  timeoutMs?: number;
  pollIntervalMs?: number;
  authGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<"idle" | "timed_out" | "unauthenticated"> {
  const timeoutMs = input.timeoutMs ?? PIS_QUIESCENCE_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_QUIESCENCE_POLL_MS;
  const authGraceMs = input.authGraceMs ?? AUTH_GRACE_MS;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? defaultNow;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const authDeadline = startedAt + authGraceMs;
  /**
   * Once ANY probe has authenticated we know the key is on the box, so a later
   * auth blip is not the "key never landed" case and only the overall deadline
   * bounds it.
   */
  let authenticatedOnce = false;

  for (;;) {
    try {
      const res = await input.remoteExec({
        host: input.host,
        username: input.username,
        privateKeyPem: input.privateKeyPem,
        command: PIS_QUIESCENCE_PROBE_COMMAND,
        sshKeyRow: input.sshKeyRow
      });
      authenticatedOnce = true;
      // Fail OPEN: only an explicit "busy" keeps us waiting. Adopt's probe
      // asks the opposite question (`includes("idle")`) and that is right for
      // adopt, which runs from a debug script with 25 minutes and no route
      // deadline over it. Here, waiting is the dangerous branch: this sits
      // inside the term-renewal sweep's 1800s budget, so a probe that runs but
      // answers something unexpected (empty stdout, no `pgrep` on a minimal
      // template, any shell quirk) would burn ten minutes and CAUSE a failure
      // that would not otherwise happen. Proceeding is the safe branch: the
      // bootstrap it hands off to has its own `wait_for_apt` and its own
      // connect-retry, and skipping the wait entirely is exactly what this
      // path did before today.
      if (!res.stdout.includes("busy")) return "idle";
    } catch (err) {
      // An auth rejection is NOT proof the key will never arrive: the
      // post-install script we are waiting on is the thing that writes it, so
      // early probes legitimately get rejected until that line runs. Keep
      // waiting through AUTH_GRACE_MS, then conclude the key is not coming and
      // hand back so the bootstrap can raise the real error inside its own
      // retry rather than at the end of the full quiescence budget.
      if (isSshAuthFailure(err) && !authenticatedOnce && now() >= authDeadline) {
        return "unauthenticated";
      }
      // Anything else (refused, timed out, handshake) means sshd is still
      // coming up. That is indistinguishable from "still busy" here, and the
      // bootstrap phase has its own connect-retry, so keep waiting.
    }
    if (now() >= deadline) return "timed_out";
    await sleep(pollIntervalMs);
  }
}

/**
 * True when SSH got far enough to be REJECTED, rather than failing to connect.
 * Distinct from {@link isSshConnectError}, which deliberately matches the
 * broader "sshExec: connection error: ..." prefix that auth failures also
 * carry: retrying a refused port is right, retrying a rejected key is not.
 */
function isSshAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("all configured authentication methods failed") ||
    m.includes("authentication failure") ||
    m.includes("permission denied (publickey)")
  );
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
  vpsSize: VpsSize;
  billingPeriod?: BillingPeriod | null;
  /**
   * Explicit Hostinger purchase term. Overrides the `billingPeriod`
   * derivation so a signup can buy monthly hardware for a contract customer
   * and the contract-upgrade sweep can buy exactly the shortfall term.
   */
  hostingerTerm?: HostingerBillingTerm | null;
}) => Promise<ProvisionVpsForBusinessResult>;

/**
 * Adopter for a pooled (already-owned) VPS, the no-purchase path. Same
 * output shape as {@link VpsProvisioner} so downstream phases are identical.
 */
export type VpsAdopter = (input: {
  businessId: string;
  tier: "starter" | "standard";
  vpsSize: VpsSize;
  virtualMachineId: number;
}) => Promise<ProvisionVpsForBusinessResult>;

/**
 * The `vps_inventory` reuse pool (fleet economics Phase B). Injectable so
 * tests can drive adopt-first without a database; `null` force-disables the
 * pool lookup entirely.
 */
export type VpsPool = {
  claim: typeof claimAvailableVps;
  /** Atomic claim of one specific VM id (term fail-but-charge orphan adopt). */
  claimSpecific: typeof claimSpecificAvailableVps;
  record: typeof recordVpsAssigned;
  release: typeof releaseVpsToPool;
  retire: typeof retireVps;
};

/**
 * Provisioner for the per-tenant DID purchase + assignment step. Split out so
 * tests can stub the Telnyx order-and-assign flow without touching the live
 * Telnyx API.
 *
 * The flow is **opt-in**: it only runs when `process.env.TELNYX_AUTO_PURCHASE_DID`
 * is truthy (or the caller injects a provisioner). This keeps the default
 * behavior, "operator manually assigns a DID from the admin UI", unchanged.
 */
export type DidProvisioner = (input: {
  businessId: string;
  platformDefaults: PlatformTelnyxDefaults;
  search: { countryCode?: string; areaCode?: string; administrativeArea?: string };
}) => Promise<{ toE164: string }>;

/**
 * Creates (or adopts) the tenant's DEDICATED Telnyx Call Control app +
 * outbound voice profile so the DID orders directly onto per-tenant carrier
 * infrastructure. Returns the ids to cache on business_telnyx_settings.
 */
export type TenantVoiceInfraProvisioner = (input: {
  businessId: string;
  businessName: string;
  maxConcurrentCalls: number;
}) => Promise<{ connectionId: string; outboundVoiceProfileId: string }>;

/* c8 ignore start -- production-only default factory; tests inject vpsAdopter */
function defaultVpsAdopter(client: HostingerClient): VpsAdopter {
  return ({ businessId, tier, vpsSize, virtualMachineId }) =>
    adoptVpsForBusiness({ businessId, tier, vpsSize, virtualMachineId }, { client });
}
/* c8 ignore stop */

/**
 * The production purchase wiring. EXPORTED so a test can assert what it
 * actually sends, rather than what a hand-written fixture claims it sends.
 *
 * It used to be private behind a `c8 ignore` that read "production-only
 * default factory; tests inject vpsProvisioner", and that is exactly how the
 * missing key-embed survived: every test injected its own provisioner, so
 * nothing ever looked at the real one. See
 * tests/hostinger-provision.test.ts, "production purchase wiring embeds the
 * minted key in the post-install script".
 */
export function defaultVpsProvisioner(client: HostingerClient): VpsProvisioner {
  return ({ businessId, tier, vpsSize, billingPeriod, hostingerTerm }) =>
    provisionVpsForBusiness(
      {
        businessId,
        tier,
        vpsSize,
        billingPeriod: billingPeriod ?? null,
        hostingerTerm: hostingerTerm ?? null,
        // Attempt to attach the bootstrap as Hostinger's first-boot
        // post-install script. provisionVpsForBusiness gracefully degrades
        // on the 403 chicken-and-egg ("account doesn't yet own a VPS") so
        // the SSH-bootstrap phase below always runs the same content
        // afterward. Either path produces the same state because the
        // script is idempotent.
        //
        // A BUILDER, not a string: the script has to carry the public key
        // as an authorized_keys write, and that key does not exist until
        // provisionVpsForBusiness mints it. Passing a finished string here
        // is what left the purchase path unable to embed the key at all,
        // depending instead on Hostinger's `public_key_ids`, which drops
        // silently and stranded a paid box for Scar Fairy on 2026-08-29.
        buildPostInstallScript: (authorizedSshPublicKey) =>
          buildDefaultPostInstallScript({ tier, vpsSize, authorizedSshPublicKey })
      },
      {
        client,
        // Wired so the moment before the charge is on the record. The hook has
        // existed in provisionVpsForBusiness since it was written but was
        // never passed here, so a fail-but-charge left no durable trace of the
        // exact item_id and hostname we sent, which is what you need to tell a
        // renamed SKU apart from a rejected hostname after the fact.
        onProgress: (phase, meta) => {
          if (phase !== "purchase_initiated") return;
          logger.info("Hostinger purchase initiated", { businessId, ...meta });
          void recordProvisioningProgress({
            businessId,
            phase: "purchase_initiated",
            percent: 10,
            message: `Buying Hostinger box: item ${String(meta?.itemId)}, hostname ${String(meta?.hostname)}`,
            source: "orchestrator",
            status: "thinking"
          }).catch((err: unknown) => {
            logger.warn("failed to record purchase_initiated", {
              businessId,
              error: err instanceof Error ? err.message : String(err)
            });
          });
        }
      }
    );
}

/**
 * Placeholder provisioner for providers that have no generic purchase path.
 * BYOS boxes are enrolled through the admin SSH-handover flow (which
 * injects its own provisioner), reaching this thrower means a BYOS
 * business hit the generic purchase path. Fail loudly with the next step
 * instead of silently buying a box for a tenant who supplies their own.
 */
function unavailableProviderProvisioner(provider: VpsProvider): VpsProvisioner {
  return async () => {
    throw new Error(
      `No default VPS provisioner for provider '${provider}': ` +
        "BYOS boxes are enrolled via the admin SSH-handover flow, not the purchase path."
    );
  };
}

/**
 * Default OVH (Canada / Beauharnois) provisioner. Lazily constructed on
 * first call so that (a) the OVH client module stays out of the module
 * graph for the 99% of provisions that are Hostinger, and (b) missing
 * OVH_* env vars fail THIS provision loudly instead of throwing during the
 * eager fallback selection and breaking every provider's provisioning.
 */
function defaultOvhProvisioner(): VpsProvisioner {
  return async (input) => {
    const [{ makeOvhProvisioner }, { ovhClientFromEnv }] = await Promise.all([
      import("@/lib/ovh/provision"),
      import("@/lib/ovh/client")
    ]);
    return makeOvhProvisioner({ client: ovhClientFromEnv() })(input);
  };
}

/* c8 ignore start -- production-only default factory; tests inject didProvisioner */
function defaultDidProvisioner(): DidProvisioner {
  return async ({ businessId, platformDefaults, search }) => {
    const apiKey = process.env.TELNYX_API_KEY ?? "";
    if (!apiKey) throw new Error("TELNYX_API_KEY missing, cannot auto-purchase DID");
    const telnyxNumbers = new TelnyxNumbersClient({ apiKey });
    const result = await orderAndAssignDidForBusiness(
      { businessId, platformDefaults, search },
      { telnyxNumbers }
    );
    return { toE164: result.route.to_e164 };
  };
}
/* c8 ignore stop */

/* c8 ignore start -- production-only default factory; tests inject tenantVoiceInfra */
function defaultTenantVoiceInfraProvisioner(): TenantVoiceInfraProvisioner {
  return async (input) => {
    const apiKey = process.env.TELNYX_API_KEY ?? "";
    if (!apiKey) throw new Error("TELNYX_API_KEY missing, cannot create tenant voice infra");
    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL missing, cannot derive the voice dispatch webhook URL");
    }
    const infra = new TelnyxVoiceInfraClient({ apiKey });
    return ensureTenantVoiceInfra(
      { infra },
      { ...input, webhookUrl: voiceDispatchWebhookUrl(supabaseUrl) }
    );
  };
}
/* c8 ignore stop */

/* c8 ignore next 3 -- trivial default; tests inject a mock sleep */
function defaultDeployPollSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exit codes from deploy-client.sh when another deploy holds the flock. */
export const DEPLOY_CLIENT_LOCK_BUSY_EXIT = 75;

const DEPLOY_CLIENT_POLL_DEFAULT_MS = 5_000;
/**
 * Standalone default: a signup starts phase 4 almost immediately, so aligning
 * with Vercel maxDuration (1800s) minus a small buffer is right for it.
 */
export const DEPLOY_CLIENT_DEADLINE_DEFAULT_MS = 28 * 60 * 1000;

/** The migrate-size / term-renewal route budget (`maxDuration = 1800`). */
export const MIGRATION_ROUTE_BUDGET_MS = 1800 * 1000;
/**
 * Held back for what happens AFTER the deploy on a migration: restore the
 * tarball, repoint billing, stop the old VM, disable its auto-renewal, pool it.
 */
export const MIGRATION_CUTOVER_RESERVE_MS = 8 * 60 * 1000;
/**
 * Never hand the deploy less than this. Below it the poll is pointless: better
 * to let it run, fail cleanly, and leave the old box untouched (the cutover
 * refuses on a failed deploy) than to give it 30 seconds.
 */
export const MIGRATION_DEPLOY_MIN_DEADLINE_MS = 5 * 60 * 1000;

/**
 * How long the deploy may run given time already spent.
 *
 * The 28-minute constant assumed phase 4 starts at t=0. In a migration it does
 * not: snapshot, SSH tarball backup, purchase, boot and bootstrap run first,
 * realistically 12 to 18 minutes. A deploy allowed the full 28 minutes finished
 * around minute 45, past the route ceiling, leaving restore and teardown no
 * budget at all.
 */
export function remainingDeployDeadlineMs(elapsedMs: number): number {
  const left = MIGRATION_ROUTE_BUDGET_MS - elapsedMs - MIGRATION_CUTOVER_RESERVE_MS;
  return Math.max(
    MIGRATION_DEPLOY_MIN_DEADLINE_MS,
    Math.min(DEPLOY_CLIENT_DEADLINE_DEFAULT_MS, left)
  );
}

/**
 * Deadline for the deploy poll given the caller's budget start.
 *
 * `undefined` (the signup case) means "no caller budget", and the poll falls
 * back to {@link DEPLOY_CLIENT_DEADLINE_DEFAULT_MS} on its own.
 */
export function deployDeadlineForBudget(
  budgetStartedAtMs: number | undefined,
  nowMs: () => number
): number | undefined {
  if (budgetStartedAtMs === undefined) return undefined;
  return remainingDeployDeadlineMs(nowMs() - budgetStartedAtMs);
}

export type DetachedDeployPollResult =
  | { ok: true; source: "exit_file" | "progress" }
  | { ok: false; reason: string; exitCode?: number };

/**
 * Poll until a background `deploy-client.sh` finishes (exit file or
 * terminal progress phase), or until the deadline.
 *
 * Mid-run progress POSTs from the box already heartbeat `provisioning_jobs`;
 * this loop only decides success/failure for the orchestrator.
 */
export async function waitForDetachedDeployClient(input: {
  businessId: string;
  host: string;
  username: string;
  privateKeyPem: string;
  sshKeyRow?: HostKeyPinnable;
  remoteExec: RemoteExecutor;
  latestProvisioningStatus: (
    businessId: string
  ) => Promise<LatestProvisioningStatus>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  deadlineMs?: number;
}): Promise<DetachedDeployPollResult> {
  const sleep = input.sleep ?? defaultDeployPollSleep;
  const now = input.now ?? Date.now;
  const pollIntervalMs = input.pollIntervalMs ?? DEPLOY_CLIENT_POLL_DEFAULT_MS;
  const deadlineMs = input.deadlineMs ?? DEPLOY_CLIENT_DEADLINE_DEFAULT_MS;
  const deadline = now() + deadlineMs;
  const exitFile = `/var/run/nc-deploy-${input.businessId}.exit`;
  const pidFile = `/var/run/nc-deploy-${input.businessId}.pid`;
  // One short SSH: print exit code if present, else empty; then whether the
  // recorded pid is still alive. Keep it tiny so a hung deploy does not
  // burn the Vercel budget on a long SSH.
  const probeCmd =
    `if [ -f ${exitFile} ]; then cat ${exitFile}; else echo MISSING; fi; ` +
    `if [ -f ${pidFile} ] && kill -0 "$(cat ${pidFile})" 2>/dev/null; then echo RUNNING; else echo STOPPED; fi`;

  while (now() < deadline) {
    const latest = await input.latestProvisioningStatus(input.businessId);
    if (latest?.phase === "deploy_client_complete") {
      return { ok: true, source: "progress" };
    }
    if (latest?.phase === "deploy_client_failed") {
      return {
        ok: false,
        reason: latest.phase,
        exitCode: undefined
      };
    }

    try {
      const probe = await input.remoteExec({
        host: input.host,
        username: input.username,
        privateKeyPem: input.privateKeyPem,
        command: probeCmd,
        sshKeyRow: input.sshKeyRow
      });
      const lines = (probe.stdout ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const exitLine = lines[0] ?? "MISSING";
      const pidState = lines[1] ?? "STOPPED";
      // Ignore a leftover exit file while a deploy PID is still alive (or
      // between start and the script's rm of the previous exit file).
      if (
        exitLine !== "MISSING" &&
        /^\d+$/.test(exitLine) &&
        pidState !== "RUNNING"
      ) {
        const code = Number(exitLine);
        if (code === 0) return { ok: true, source: "exit_file" };
        return {
          ok: false,
          reason: `deploy-client.sh exit ${code}`,
          exitCode: code
        };
      }
    } catch (err) {
      /* c8 ignore next 5 -- transient SSH; poll continues */
      logger.warn("Detached deploy probe SSH failed; will retry", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    reason: `deploy-client.sh did not finish within ${deadlineMs}ms`
  };
}

/**
 * Start deploy-client.sh under nohup (script owns flock) and poll to
 * completion. If flock is busy (exit 75), attach to the in-flight deploy.
 */
export async function runDetachedDeployClient(input: {
  businessId: string;
  envVars: string;
  host: string;
  username: string;
  privateKeyPem: string;
  sshKeyRow?: HostKeyPinnable;
  remoteExec: RemoteExecutor;
  latestProvisioningStatus: (
    businessId: string
  ) => Promise<LatestProvisioningStatus>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  deadlineMs?: number;
}): Promise<DetachedDeployPollResult> {
  const logPath = `/var/log/nc-deploy-${input.businessId}.log`;
  const lockPath = `/var/lock/nc-deploy-${input.businessId}.lock`;
  const exitPath = `/var/run/nc-deploy-${input.businessId}.exit`;
  const canStartFresh = /\bBUSINESS_ID=/.test(input.envVars);

  // Without BUSINESS_ID we must not spawn deploy-client.sh (script
  // hard-requires it). Poll an in-flight or already-finished deploy only.
  if (!canStartFresh) {
    logger.info("deploy-client.sh start skipped: no BUSINESS_ID in env; attaching to poll", {
      businessId: input.businessId
    });
    return waitForDetachedDeployClient({
      businessId: input.businessId,
      host: input.host,
      username: input.username,
      privateKeyPem: input.privateKeyPem,
      sshKeyRow: input.sshKeyRow,
      remoteExec: input.remoteExec,
      latestProvisioningStatus: input.latestProvisioningStatus,
      sleep: input.sleep,
      now: input.now,
      pollIntervalMs: input.pollIntervalMs,
      deadlineMs: input.deadlineMs
    });
  }

  // Pre-check flock so a busy deploy surfaces as exit 75 on this short SSH
  // (nohup would otherwise mask the script's own flock exit). Clear any
  // stale exit file only when we are about to start a fresh deploy.
  const startCmd =
    `if ! flock -n ${lockPath} true; then exit ${DEPLOY_CLIENT_LOCK_BUSY_EXIT}; fi; ` +
    `rm -f ${exitPath}; ` +
    `${input.envVars} nohup /opt/deploy-client.sh >>${logPath} 2>&1 & echo $!`;

  let started = false;
  try {
    const start = await input.remoteExec({
      host: input.host,
      username: input.username,
      privateKeyPem: input.privateKeyPem,
      command: startCmd,
      sshKeyRow: input.sshKeyRow
    });
    if (start.exitCode === DEPLOY_CLIENT_LOCK_BUSY_EXIT) {
      logger.info("deploy-client.sh already running; attaching to poll", {
        businessId: input.businessId
      });
      started = true;
    } else if (start.exitCode !== 0) {
      return {
        ok: false,
        reason: `failed to start deploy-client.sh (exit ${start.exitCode}): ${(start.stderr || start.stdout || "").slice(0, 2000)}`,
        exitCode: start.exitCode
      };
    } else {
      started = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to start deploy-client.sh: ${msg}` };
  }

  /* c8 ignore start -- defensive; start paths above always set started or return */
  if (!started) {
    return { ok: false, reason: "failed to start deploy-client.sh" };
  }
  /* c8 ignore stop */

  return waitForDetachedDeployClient({
    businessId: input.businessId,
    host: input.host,
    username: input.username,
    privateKeyPem: input.privateKeyPem,
    sshKeyRow: input.sshKeyRow,
    remoteExec: input.remoteExec,
    latestProvisioningStatus: input.latestProvisioningStatus,
    sleep: input.sleep,
    now: input.now,
    pollIntervalMs: input.pollIntervalMs,
    deadlineMs: input.deadlineMs
  });
}

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
    /**
     * Adopter for pooled VMs. Defaults to {@link adoptVpsForBusiness} on the
     * Hostinger client. Only invoked when the pool yields a claim.
     */
    vpsAdopter?: VpsAdopter;
    /**
     * VPS reuse pool. Defaults to the real `vps_inventory` helpers; pass
     * `null` to force the purchase path (tests, break-glass).
     */
    vpsPool?: VpsPool | null;
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
     * Per-tenant Telnyx voice infra (dedicated Call Control app + outbound
     * voice profile). Runs only when the DID step runs; a production
     * default is used when omitted. Pass `null` to force-skip during tests.
     * Failure never aborts provisioning: the DID degrades to the shared
     * platform app and the migration one-shot converges stragglers.
     */
    tenantVoiceInfra?: TenantVoiceInfraProvisioner | null;
    /**
     * Test-injectable sleep used by the SSH-bootstrap connect-retry loop
     * and the detached deploy-client poll. Production uses `setTimeout`;
     * tests inject a no-op so retry assertions run without burning real
     * wall-clock time.
     */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Latest provisioning progress row. Defaults to
     * {@link getLatestProvisioningStatus}; tests inject a stub so the
     * detached-deploy poll does not hit Supabase.
     */
    /** Repeat-purchase refusal row-count source (tests). */
    countAssignedFor?: typeof countAssignedVpsForBusiness;
    latestProvisioningStatus?: (
      businessId: string
    ) => Promise<LatestProvisioningStatus>;
    /**
     * Injectable clock for the orphan-scan retry deadline and the
     * post-install quiescence wait. Production uses `Date.now`; tests inject
     * a controllable clock so those budgets can expire without waiting. A
     * no-op `sleep` alone is not enough for either: both are wall-clock, so
     * without a fake clock a test asserting a give-up path spins against real
     * minutes.
     */
    now?: () => number;
    /**
     * Orphan reconciler for Hostinger's fail-but-charge purchases. When the
     * purchase endpoint throws, this lists the account's VMs and pools any
     * recent box `vps_inventory` doesn't know about so the provision can
     * adopt it instead of failing (see `reconcileOrphanedPurchases`).
     * Defaults to the real implementation on the Hostinger client; pass
     * `null` to disable (tests, break-glass).
     */
    orphanReconciler?: (() => Promise<ReconciledOrphan[]>) | null;
    /**
     * Hostinger paid-through lookup used to stamp `vps_inventory.expires_at`
     * on a freshly purchased box. Defaults to the real Hostinger list call;
     * tests inject. Never throws by contract, see
     * `resolvePaidThroughForBillingSub`.
     */
    resolvePaidThrough?: (billingSubscriptionId: string | null) => Promise<string | null>;
  }
): Promise<ProvisioningResult> {
  const { businessId, ownerEmail, ownerPhone, tier, billingPeriod, suppressOwnerNotify } = input;
  const narrowTier = resolveBoxTier(tier);
  // Size resolution keys on the REAL tier so enterprise gets its kvm8
  // default rather than standard's kvm2; an explicit vps_size pin wins.
  const vpsSize = resolveVpsSize(tier, input.vpsSize);

  logger.info("Starting provisioning", {
    businessId,
    tier: narrowTier,
    vpsSize,
    billingPeriod: billingPeriod ?? null
  });

  // Co-tenanted hardware WARNS, never refuses. Provisioning is the path that
  // recovers a broken box, so it must not gain a new way to fail. But a
  // reprovision can re-image the machine, which takes a second product's
  // service with it, so the operator reading these logs needs to know what
  // else is on there and who has to redeploy it.
  const sharedBox = sharedHardwareFor(businessId);
  if (sharedBox) {
    logger.warn("Provisioning a CO-TENANTED box", {
      businessId,
      vmId: sharedBox.vmId,
      hostname: sharedBox.hostname,
      coTenants: sharedBox.coTenants.map((c) => c.name),
      detail: sharedHardwareWarning(sharedBox)
    });
  }

  await recordProvisioningProgress({
    businessId,
    phase: "started",
    percent: 5,
    message: "Provisioning started",
    source: "orchestrator"
  });

  try {
    return await runOrchestrator(
      {
        businessId,
        ownerEmail,
        ownerPhone,
        tier: narrowTier,
        vpsSize,
        billingPeriod,
        // Explicit purchase term, when the caller named one. This object is
        // rebuilt field by field rather than spread, so a new input that is
        // not listed here is silently dropped.
        hostingerTerm: input.hostingerTerm,
        skipPoolAdopt: input.skipPoolAdopt,
        suppressOwnerNotify,
        notifyOpsNewSignup: input.notifyOpsNewSignup
      },
      deps
    );
  } catch (err) {
    // Top-level safety net. Several inner steps already record their own
    // `status: "error"` rows AND swallow the error (cloudflare, DID, deploy),
    // but the calls before the cloudflare phase, `vpsProvisioner`,
    // `updateBusinessStatus`, the config writes, are unprotected, so a
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
 * branches without a synthetic uninstrumented arm, when this lived
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

/**
 * Compact, bounded rendering of a Hostinger error body for a log message.
 *
 * `describeProvisioningError` has always captured `body`, and it is where the
 * actual cause lives (`{"errors":{"hostname":["..."]}}` tells you which field
 * Hostinger rejected, where the status alone does not). It used to be dropped
 * here and survive only in a console-only `logger.error`, so after the fact
 * there was no queryable record of whether an incident was a 402, a 422, or
 * our own timeout. Bounded because this lands in `provisioning_jobs.last_error`,
 * which truncates at 1000 chars.
 */
export function formatHostingerErrorBody(body: unknown, maxLength = 300): string | null {
  if (body === null || body === undefined) return null;
  let rendered: string;
  try {
    rendered = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    // Circular or otherwise unserializable: the body is not worth failing over.
    return null;
  }
  if (!rendered || rendered === "{}" || rendered === '""') return null;
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}...` : rendered;
}

function formatProvisioningErrorMessage(detail: ProvisioningErrorDetail): string {
  const body = formatHostingerErrorBody(detail.body);
  const bodySuffix = body ? ` body=${body}` : "";
  if (detail.endpoint && typeof detail.status === "number") {
    return `Provisioning failed: Hostinger ${detail.endpoint} → HTTP ${detail.status} (${detail.message})${bodySuffix}`;
  }
  return `Provisioning failed: ${detail.message}${bodySuffix}`;
}

/**
 * Persist a fail-but-charge recovery so the rate is measurable.
 *
 * These paths end in a SUCCESSFUL provision on a box we already paid for, and
 * until now the only trace was a `logger.warn` to the console. That is why the
 * Jul 29 KYP incident has no queryable record of whether Hostinger returned a
 * 402, a 422, or whether we aborted on our own timeout.
 *
 * Deliberately `status: "thinking"` and not `"error"`: this row is mirrored to
 * the owner-visible provisioning progress feed, and the provision is in fact
 * fine. #1045 fixed telling an owner they were live when the deploy failed;
 * showing a failure on a provision that succeeds is the same bug reversed.
 * Best-effort, exactly like every other bookkeeping write on this path.
 */
/**
 * Copy for the recovery row. Pulled out as a pure function so each arm is
 * directly testable, the same reason {@link describeAttachError} exists: v8
 * cannot always see both arms of a ternary buried in an async body.
 */
export function formatFailButChargeRecoveryMessage(
  detail: ProvisioningErrorDetail,
  adoptedVirtualMachineId: string | number
): string {
  const endpoint =
    detail.endpoint && typeof detail.status === "number"
      ? `${detail.endpoint} → HTTP ${detail.status}`
      : "purchase";
  const body = formatHostingerErrorBody(detail.body);
  const bodySuffix = body ? ` body=${body}` : "";
  return (
    `Hostinger ${endpoint} failed but the box was created and charged anyway; ` +
    `adopted VM ${adoptedVirtualMachineId} instead of buying another. ` +
    `(${detail.message})${bodySuffix}`
  );
}

async function recordFailButChargeRecovery(input: {
  businessId: string;
  adoptedVirtualMachineId: string | number;
  purchaseError: unknown;
}): Promise<void> {
  try {
    await recordProvisioningProgress({
      businessId: input.businessId,
      phase: "purchase_fail_but_charge_recovered",
      percent: 12,
      message: formatFailButChargeRecoveryMessage(
        describeProvisioningError(input.purchaseError),
        input.adoptedVirtualMachineId
      ),
      source: "orchestrator",
      status: "thinking"
    });
  } catch (logErr) {
    logger.warn("failed to record fail-but-charge recovery", {
      businessId: input.businessId,
      error: describeAttachError(logErr)
    });
  }
}

/**
 * Claim + adopt one pooled box. Extracted from {@link acquireVps} so the
 * purchase-failure reconciliation path below can re-run the exact same
 * adopt sequence after pooling an orphaned VM. Returns `null` when there is
 * nothing claimable or the adopt fails (after retiring the bad box), the
 * caller decides whether to fall through to purchase or surface an error.
 */
async function tryAdoptFromPool(args: {
  businessId: string;
  tier: "starter" | "standard";
  vpsSize: VpsSize;
  vpsPool: VpsPool;
  vpsAdopter: VpsAdopter;
}): Promise<ProvisionVpsForBusinessResult | null> {
  const { businessId, tier, vpsSize, vpsPool, vpsAdopter } = args;
  let claimed: Awaited<ReturnType<VpsPool["claim"]>> = null;
  try {
    claimed = await vpsPool.claim(vpsSize, businessId);
  } catch (err) {
    logger.warn("vps pool claim failed, falling back to purchase", {
      businessId,
      vpsSize,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  if (!claimed) return null;

  logger.info("vps pool hit, adopting owned box instead of purchasing", {
    businessId,
    virtualMachineId: claimed.vm_id,
    vpsSize
  });
  try {
    const adopted = await vpsAdopter({
      businessId,
      tier,
      vpsSize,
      virtualMachineId: claimed.vm_id
    });
    try {
      await vpsPool.record({
        vmId: claimed.vm_id,
        plan: vpsSize,
        businessId,
        // Same fallback chain as tryAdoptSpecificVm: a transient failure in
        // adopt's best-effort sub-id lookup must not ERASE the id the pool
        // row already carries, or the daily expiry refresh skips the row
        // forever and the runway floor hides a paid box from every claim.
        hostingerBillingSubscriptionId:
          adopted.hostingerBillingSubscriptionId ?? claimed.hostinger_billing_subscription_id,
        notes: `adopted from pool for ${businessId}`
      });
    } catch (err) {
      logger.warn("vps pool bookkeeping failed after adopt (continuing)", {
        businessId,
        virtualMachineId: claimed.vm_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    // Admin release-to-pool cascade: the adopt recreated the box, so any
    // OTHER (non-wiped) business still pointing at this VM is a stale
    // control surface over the NEW tenant's hardware, cascade-delete it
    // (see stale-tenant-cleanup.ts). Best-effort: a cleanup failure logs
    // loudly but must never abort a signup that already has its box.
    try {
      await cleanupStaleTenantsForVm({ vmId: claimed.vm_id, newBusinessId: businessId });
    } catch (err) {
      logger.error("stale-tenant cleanup after adopt failed (continuing)", {
        businessId,
        virtualMachineId: claimed.vm_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return adopted;
  } catch (err) {
    // A box that failed the proven adopt sequence (setup 4xx, key never
    // attaching, terminal VM state, 404 = already lapsed/deleted) is not
    // safe to hand to the next signup either, retire it for the audit
    // trail and buy fresh.
    logger.warn("vps adopt failed, retiring pooled box and purchasing", {
      businessId,
      virtualMachineId: claimed.vm_id,
      error: err instanceof Error ? err.message : String(err)
    });
    try {
      await vpsPool.retire(
        claimed.vm_id,
        `adopt failed for ${businessId}: ${err instanceof Error ? err.message : String(err)}`
      );
    } catch (retireErr) {
      logger.warn("vps pool retire after adopt failure failed (continuing)", {
        businessId,
        virtualMachineId: claimed.vm_id,
        error: retireErr instanceof Error ? retireErr.message : String(retireErr)
      });
    }
    return null;
  }
}

/**
 * Adopt a SPECIFIC Hostinger VM after an atomic pool claim on that vm_id.
 * Used by the change-plan term-alignment fail-but-charge path: the
 * reconciled orphan IS the term-bought box, and claiming "any kvm2" could
 * hand back a monthly lapser instead. Claim runs first so a concurrent
 * adopt-first provision cannot take the same `available` orphan mid-setup.
 */
async function tryAdoptSpecificVm(args: {
  businessId: string;
  tier: "starter" | "standard";
  vpsSize: VpsSize;
  virtualMachineId: number;
  hostingerBillingSubscriptionId: string | null;
  vpsPool: VpsPool;
  vpsAdopter: VpsAdopter;
  notes: string;
}): Promise<ProvisionVpsForBusinessResult | null> {
  const {
    businessId,
    tier,
    vpsSize,
    virtualMachineId,
    hostingerBillingSubscriptionId,
    vpsPool,
    vpsAdopter,
    notes
  } = args;

  let claimed: Awaited<ReturnType<typeof claimSpecificAvailableVps>>;
  try {
    claimed = await vpsPool.claimSpecific(virtualMachineId, businessId);
  } catch (err) {
    logger.warn("specific orphan pool claim failed (continuing to surface purchase error)", {
      businessId,
      virtualMachineId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
  if (!claimed) {
    logger.warn("specific orphan already claimed by another provision", {
      businessId,
      virtualMachineId
    });
    return null;
  }

  logger.info("adopting specific reconciled Hostinger VM (term fail-but-charge)", {
    businessId,
    virtualMachineId,
    vpsSize
  });
  try {
    const adopted = await vpsAdopter({
      businessId,
      tier,
      vpsSize,
      virtualMachineId
    });
    try {
      await vpsPool.record({
        vmId: virtualMachineId,
        plan: vpsSize,
        businessId,
        hostingerBillingSubscriptionId:
          adopted.hostingerBillingSubscriptionId ??
          hostingerBillingSubscriptionId ??
          claimed.hostinger_billing_subscription_id,
        notes
      });
    } catch (err) {
      logger.warn("vps pool bookkeeping failed after specific adopt (continuing)", {
        businessId,
        virtualMachineId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    try {
      await cleanupStaleTenantsForVm({ vmId: virtualMachineId, newBusinessId: businessId });
    } catch (err) {
      logger.error("stale-tenant cleanup after specific adopt failed (continuing)", {
        businessId,
        virtualMachineId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return adopted;
  } catch (err) {
    logger.warn("specific orphan adopt failed, retiring box and surfacing purchase error", {
      businessId,
      virtualMachineId,
      error: err instanceof Error ? err.message : String(err)
    });
    try {
      await vpsPool.retire(
        virtualMachineId,
        `specific adopt failed for ${businessId}: ${err instanceof Error ? err.message : String(err)}`
      );
    } catch (retireErr) {
      logger.warn("vps pool retire after specific adopt failure failed (continuing)", {
        businessId,
        virtualMachineId,
        error: retireErr instanceof Error ? retireErr.message : String(retireErr)
      });
    }
    return null;
  }
}

/**
 * True when the thrown error is a failure of Hostinger's PURCHASE endpoint
 * (`POST /api/vps/v1/virtual-machines`), the only call that can leave a
 * fail-but-charge orphan behind. Duck-typed on `name` for the same
 * import-cycle reason as `describeProvisioningError`.
 */
function isHostingerPurchaseFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "HostingerApiError") return false;
  const endpoint = (err as Error & { endpoint?: unknown }).endpoint;
  return endpoint === "/api/vps/v1/virtual-machines";
}

/**
 * Acquire a VPS for the business. Prefer adopting a pooled box (fleet
 * economics Phase B); fall back to purchase. On Hostinger purchase failure,
 * reconcile fail-but-charge orphans (with retries) and adopt.
 *
 * Outcomes:
 *   * pool hit → adopt (setup/recreate) the claimed box;
 *   * purchase → record the new box as assigned inventory.
 *   * purchase fails-but-charges → poll/reconcile orphans, then adopt;
 *     for `skipPoolAdopt` adopt the SPECIFIC term orphan by id.
 *
 * Pool reads/writes are all best-effort: `vps_inventory` is an economics
 * optimization, so a pool outage degrades to "buy a box like before" rather
 * than blocking the signup.
 *
 * Fail-but-charge recovery: Hostinger's purchase endpoint has repeatedly
 * (Jul 5 + Jul 8 + Jul 28 2026) returned an error (402 card-declined, 422
 * hostname) while STILL charging the card and creating the VM, sometimes
 * ~a minute AFTER the error response. When the purchase call throws, we
 * poll the orphan reconciler (up to ~5 min) until a size-matching unpaid
 * box appears, pool it, and adopt it so the signup / term switch lands on
 * the box that was already paid for instead of failing (or worse, buying
 * a second box on retry).
 *
 * Term purchases (`skipPoolAdopt`, change-plan term alignment): the paid
 * orphan IS the term-bought box, so we adopt that specific VM rather than
 * aborting. Adopting an arbitrary pooled monthly lapser would defeat the
 * term-pricing goal; adopting THIS orphan preserves it.
 */
async function acquireVps(args: {
  businessId: string;
  tier: "starter" | "standard";
  vpsSize: VpsSize;
  /**
   * Provider axis. The `vps_inventory` pool is Hostinger-owned stock, so
   * both the adopt-first claim AND the post-acquire bookkeeping only run
   * for hostinger tenants, a BYOS/OVH provision must never land on (or
   * record into) the Hostinger reuse pool.
   */
  vpsProvider: VpsProvider;
  billingPeriod: BillingPeriod | null;
  /** Explicit purchase term; null falls back to the billingPeriod derivation. */
  hostingerTerm: HostingerBillingTerm | null;
  skipPoolAdopt: boolean;
  vpsPool: VpsPool | null;
  vpsAdopter: VpsAdopter;
  vpsProvisioner: VpsProvisioner;
  /** Orphan reconciler for fail-but-charge purchases. Null disables. */
  reconcileOrphans: (() => Promise<ReconciledOrphan[]>) | null;
  /**
   * Hostinger paid-through lookup for the box we just bought, stamped onto
   * the inventory row so adopt-first ranking knows its runway immediately
   * instead of waiting a day for the billing-posture cron. Best-effort:
   * resolves to null on any failure and the row keeps an unknown expiry.
   */
  resolvePaidThrough: (billingSubscriptionId: string | null) => Promise<string | null>;
  /**
   * Assigned-row count for this business; drives the skipPoolAdopt
   * repeat-purchase refusal. Tests inject; production defaults to the
   * vps_inventory read.
   */
  countAssignedFor?: typeof countAssignedVpsForBusiness;
  /** Injectable sleep for the orphan-scan retry loop (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the orphan-scan deadline (tests). */
  now?: () => number;
}): Promise<ProvisionVpsForBusinessResult> {
  const { businessId, tier, vpsSize, vpsProvider, billingPeriod, hostingerTerm, skipPoolAdopt, vpsPool, vpsAdopter, vpsProvisioner } =
    args;
  const hostingerManaged = providerUsesHostingerLifecycle(vpsProvider);
  /* c8 ignore next -- production default; tests inject sleep */
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /* c8 ignore next -- production default; tests inject now */
  const now = args.now ?? Date.now;

  if (vpsPool && !skipPoolAdopt && hostingerManaged) {
    const adopted = await tryAdoptFromPool({ businessId, tier, vpsSize, vpsPool, vpsAdopter });
    if (adopted) return adopted;
  }
  if (skipPoolAdopt && hostingerManaged) {
    // V1 residual: a migration killed between percent 15 (purchase done)
    // and 40 (the watchdog's safe-resume floor) falls through to a full
    // re-run with skipPoolAdopt, and the old code purchased AGAIN;
    // max_attempts is 3, so up to two extra term-priced boxes per incident.
    // Auto-reclaiming the paid box is NOT safe (on a first-attempt term
    // migration the tenant's LIVE box is itself an assigned inventory row,
    // and adopting recreates hardware), and a recency window is wrong in
    // both directions (a same-day upgrade's live box is "recent", a >6h
    // stalled retry is not). The time-free dead-attempt signature is the
    // ROW COUNT: the fleet invariant is at most one assigned row per
    // business, the dead attempt's purchase was recorded as a second one
    // at percent <15, and a first attempt always sees exactly one. On two
    // or more, refuse: the thrown error fails the job, the stuck alert
    // (V5) pages a human, and the billing-posture stale_assigned_row
    // check names the leftover row to clean up. (A death DURING purchase
    // records no row; that case is the fail-but-charge orphan adopt,
    // handled above via claimSpecific.)
    /* c8 ignore next -- production default; tests inject countAssignedFor */
    const countAssignedFor = args.countAssignedFor ?? countAssignedVpsForBusiness;
    const assignedRows = await countAssignedFor(businessId);
    if (assignedRows >= 2) {
      throw new Error(
        `refusing another VPS purchase for ${businessId}: it already holds ` +
          `${assignedRows} assigned inventory rows (dead-attempt signature; the ` +
          "invariant is one). Reclaim or release the extra box, then retry; the " +
          "billing-posture stale_assigned_row finding names it."
      );
    }
  }

  // Stamp before the purchase call so the orphan wait only accepts VMs
  // created for THIS attempt (5s clock-skew slack). A longer lookback can
  // attribute an unrelated same-size fail-but-charge from seconds earlier.
  const purchaseStartedAt = now();
  const orphanMinCreatedAtMs = purchaseStartedAt - 5_000;

  let purchased: ProvisionVpsForBusinessResult;
  try {
    purchased = await vpsProvisioner({ businessId, tier, vpsSize, billingPeriod, hostingerTerm });
  } catch (err) {
    // Purchase failed. If this was the Hostinger purchase endpoint, the VM
    // may exist anyway (fail-but-charge), reconcile orphans into the pool
    // (with retries for Hostinger's async materialization), then adopt so
    // the provision still lands on the box that was already paid for.
    // Reconciliation is best-effort: any failure inside it must never mask
    // the original purchase error.
    // Two ways the account can be paying for a box this attempt is about to
    // walk away from. The purchase CALL failing is the long-known one. The
    // other is a failure after it returned (ready-poll timeout, the IPv4
    // guard, the ssh-key write): the box exists, the charge landed, and this
    // gate used to skip it entirely, so nothing ever went looking.
    const chargedVmId = chargedVirtualMachineId(err);
    if (
      vpsPool &&
      hostingerManaged &&
      args.reconcileOrphans &&
      (isHostingerPurchaseFailure(err) || chargedVmId !== null)
    ) {
      // Ceiling stamped when the purchase call FAILED: the fail-but-charge
      // VM was created during that call, so anything newer belongs to a
      // different attempt. Without it, the scan retries turned the 5s
      // backward slack into a forward-unbounded window and could adopt a
      // concurrent business's same-size fail-but-charge box (30s slack for
      // Hostinger-side clock skew, generous next to the 5s floor's).
      const orphanMaxCreatedAtMs = now() + 30_000;
      try {
        const pooled = await reconcileUntilSizeMatch({
          reconcile: args.reconcileOrphans,
          vpsSize,
          sleep,
          now,
          minCreatedAtMs: orphanMinCreatedAtMs,
          maxCreatedAtMs: orphanMaxCreatedAtMs,
          // A named box is waited for by id. Otherwise the loop would stop on
          // the first same-size orphan to appear, which after a long
          // post-charge failure can easily be a concurrent business's.
          ...(chargedVmId !== null ? { awaitVmId: chargedVmId } : {})
        });
        const sizeMatches = pooled.filter((orphan) =>
          orphanMatchesPurchaseAttempt(orphan, vpsSize, orphanMinCreatedAtMs, orphanMaxCreatedAtMs)
        );
        // Prefer the OLDEST matching orphan after the purchase stamp.
        // Concurrent same-size fail-but-charges: the earlier materialization
        // belongs to the earlier purchase; taking newest can steal a later
        // caller's term-priced box.
        // When the failure named its box, that IS the box and the ONLY box.
        // Hostinger told us which VM the charge bought, so the age heuristics
        // have nothing to infer, and falling back to them would be dangerous
        // rather than merely redundant: the created-at ceiling is stamped when
        // the failure surfaced, which after a 15-minute ready-poll is 15
        // minutes wide, so a concurrent business's same-size fail-but-charge
        // sits comfortably inside it. Adopting that would take a box someone
        // else just paid for. Size is still checked, so a box that somehow
        // came back the wrong plan stays pooled as spare capacity of its real
        // size instead of putting this tenant on the wrong hardware.
        //
        // The named box still has to have been POOLED to be adoptable, so one
        // the reconciler refused (a terminal `error` state, say) falls through
        // to the original error and the daily sweep's human report.
        const namedMatch =
          chargedVmId !== null ? pooled.find((orphan) => orphan.vmId === chargedVmId) ?? null : null;
        const sizeMatch =
          chargedVmId !== null
            ? namedMatch && orphanMatchesPurchaseAttempt(namedMatch, vpsSize)
              ? namedMatch
              : undefined
            : sizeMatches.slice().sort((a, b) => Number(a.createdAtMs) - Number(b.createdAtMs))[0];
        if (sizeMatch) {
          if (skipPoolAdopt) {
            // Term-alignment path: THIS orphan is the term-bought box. Claim
            // + adopt it by id (not via the oldest-available size claim).
            const adopted = await tryAdoptSpecificVm({
              businessId,
              tier,
              vpsSize,
              virtualMachineId: sizeMatch.vmId,
              hostingerBillingSubscriptionId: sizeMatch.hostingerBillingSubscriptionId ?? null,
              vpsPool,
              vpsAdopter,
              notes: `adopted fail-but-charge term orphan for ${businessId}`
            });
            if (adopted) {
              logger.warn(
                "Hostinger term purchase failed but the paid VM was reconciled, adopted that specific orphan",
                {
                  businessId,
                  adoptedVirtualMachineId: adopted.virtualMachineId,
                  reconciledVmIds: pooled.map((orphan) => orphan.vmId),
                  purchaseError: (err as Error).message
                }
              );
              await recordFailButChargeRecovery({
                businessId,
                adoptedVirtualMachineId: adopted.virtualMachineId,
                purchaseError: err
              });
              return adopted;
            }
          } else {
            const adopted = await tryAdoptFromPool({ businessId, tier, vpsSize, vpsPool, vpsAdopter });
            if (adopted) {
              // Note: the claim takes the FURTHEST-EXPIRY available box of
              // this size (≥72h runway), which is not necessarily one of the
              // just-reconciled orphans, either way the signup lands on an
              // already-owned box instead of failing, and the orphan stays
              // pooled for the next one.
              logger.warn(
                "Hostinger purchase failed but a paid VM was reconciled into the pool, adopted a pooled box instead",
                {
                  businessId,
                  adoptedVirtualMachineId: adopted.virtualMachineId,
                  reconciledVmIds: pooled.map((orphan) => orphan.vmId),
                  // isHostingerPurchaseFailure() gated this block, so `err`
                  // is always an Error here.
                  purchaseError: (err as Error).message
                }
              );
              await recordFailButChargeRecovery({
                businessId,
                adoptedVirtualMachineId: adopted.virtualMachineId,
                purchaseError: err
              });
              return adopted;
            }
          }
        }
      } catch (reconcileErr) {
        logger.warn("orphaned-purchase reconciliation failed (surfacing original purchase error)", {
          businessId,
          error: describeAttachError(reconcileErr)
        });
      }
    }
    throw err;
  }
  if (vpsPool && hostingerManaged) {
    try {
      // Resolve the box's paid-through BEFORE the row is written so the
      // inventory row is never briefly published with an unknown expiry.
      // Best-effort by contract: a null here just defers the column to the
      // billing-posture cron, exactly as before this lookup existed.
      const expiresAt = await args.resolvePaidThrough(
        purchased.hostingerBillingSubscriptionId
      );
      await vpsPool.record({
        // Hostinger provisioners always return the numeric VM id; the
        // string ids (byos-*/OVH service names) never reach this branch
        // because bookkeeping is gated on hostingerManaged above.
        vmId: Number(purchased.virtualMachineId),
        plan: vpsSize,
        businessId,
        hostingerBillingSubscriptionId: purchased.hostingerBillingSubscriptionId,
        // Only stamp what we actually resolved. Forwarding a null would
        // erase a paid-through already on the row (this is an upsert, and a
        // re-run after a retry can hit an existing row).
        ...(expiresAt !== null ? { expiresAt } : {}),
        // Record the purchased Hostinger term so pool triage can tell a
        // prepaid 2-year box (valuable, adopt eagerly) from a monthly one.
        notes: `purchased for ${businessId} (${hostingerTerm ?? DEFAULT_PURCHASE_TERM} term)`
      });
    } catch (err) {
      logger.warn("vps pool bookkeeping failed after purchase (continuing)", {
        businessId,
        virtualMachineId: purchased.virtualMachineId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return purchased;
}

async function runOrchestrator(
  input: ProvisioningInput & { tier: "starter" | "standard"; vpsSize: VpsSize },
  deps?: Parameters<typeof orchestrateProvisioning>[1]
): Promise<ProvisioningResult> {
  const { businessId, ownerEmail, ownerPhone, tier: narrowTier, vpsSize } = input;

  // Provider axis: which provider runs this tenant's box. Resolved from the
  // business row (single source of truth, callers don't thread it) so a
  // BYOS/OVH tenant can never be silently re-provisioned onto a Hostinger
  // purchase by a caller that predates the axis. Loaded ONCE here and
  // reused below for the config/tunnel phases. Non-hostinger providers are
  // enterprise-only; the gate reads the REAL tier from the row (narrowTier
  // collapses enterprise onto the standard box profile).
  const businessRow = await getBusiness(businessId);
  let priorOpsNewSignupAlert = false;
  try {
    priorOpsNewSignupAlert = await hasPriorOpsNewSignupAlert(businessId);
  } catch (err) {
    logger.warn("hasPriorOpsNewSignupAlert lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  const shouldSendOpsNewSignupAlert =
    input.notifyOpsNewSignup === true && !priorOpsNewSignupAlert;
  const vpsProvider = resolveVpsProvider(businessRow?.vps_provider);
  assertVpsProviderAllowed(vpsProvider, businessRow?.tier);
  // Compliance gate: a BYOS/Canada placement whose residency mode is still
  // 'supabase' would put the box up while every piece of customer content
  // stays in central US Supabase, so refuse before anything is purchased or
  // bootstrapped. (Hostinger/us tenants no-op here.)
  assertResidencyForPlacement(businessRow ?? {});
  // Same shape, stricter list: a HIPAA tenant may not land on infrastructure
  // no BAA covers. Hostinger's own hosting agreement excludes HIPAA, so this
  // refuses before PHI could reach a box we cannot cover. (Non-HIPAA tenants
  // no-op here.)
  assertHipaaPlacement(businessRow ?? {});

  const hostinger =
    deps?.hostinger ??
    new HostingerClient({
      /* c8 ignore start -- trivial env-default fallbacks */
      baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
      token: process.env.HOSTINGER_API_TOKEN ?? ""
      /* c8 ignore stop */
    });

  // Default provisioner selection keys on the provider: hostinger gets the
  // Hostinger purchase path, ovh gets the lazy OVH (Beauharnois) purchase
  // path, and byos gets a loud thrower (enrollment injects its own
  // provisioner). Selected eagerly so the provider branch is exercised on
  // every run; the factories themselves are cheap closures.
  /* c8 ignore start -- selection of the production default; tests inject vpsProvisioner (the ovh/byos fallbacks ARE executed by the no-injection tests) */
  const fallbackProvisioner = providerUsesHostingerLifecycle(vpsProvider)
    ? defaultVpsProvisioner(hostinger)
    : vpsProvider === "ovh"
      ? defaultOvhProvisioner()
      : unavailableProviderProvisioner(vpsProvider);
  /* c8 ignore stop */
  const vpsProvisioner = deps?.vpsProvisioner ?? fallbackProvisioner;
  /* c8 ignore next -- defaultVpsAdopter is the production path; tests inject vpsAdopter */
  const vpsAdopter = deps?.vpsAdopter ?? defaultVpsAdopter(hostinger);
  const vpsPool: VpsPool | null =
    deps?.vpsPool === undefined
      ? /* c8 ignore next -- production default pool; tests inject vpsPool */
        { claim: claimAvailableVps, claimSpecific: claimSpecificAvailableVps, record: recordVpsAssigned, release: releaseVpsToPool, retire: retireVps }
      : deps.vpsPool;
  /* c8 ignore next -- defaultRemoteExecutor is the production path; tests inject remoteExec */
  const remoteExec = deps?.remoteExec ?? defaultRemoteExecutor;
  const nowMs: () => number = deps?.now ?? Date.now;

  // Fail-but-charge orphan reconciler (see acquireVps). Built lazily on the
  // same Hostinger client; only ever invoked when the purchase endpoint
  // throws, so the default costs nothing on the happy path.
  let orphanReconciler: (() => Promise<ReconciledOrphan[]>) | null = null;
  if (deps?.orphanReconciler !== undefined) {
    orphanReconciler = deps.orphanReconciler;
  } else {
    /* c8 ignore start -- production default; tests inject orphanReconciler */
    orphanReconciler = () =>
      reconcileOrphanedPurchases({
        businessId,
        listVirtualMachines: () => hostinger.listVirtualMachines(),
        listInventory: () => listVpsInventory(),
        listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
        disableAutoRenew: (id) => hostinger.disableBillingAutoRenewal(id),
        release: releaseVpsToPool
      });
    /* c8 ignore stop */
  }

  // Phase 1: get a VPS. Adopt-first (fleet economics Phase B): Hostinger
  // boxes are non-refundable for us until ≈Dec 30 2026, so a pooled
  // matching-size VM is reused via the no-purchase setup/recreate path
  // before we buy a new one. Every pool interaction is best-effort, a
  // broken pool must never block a signup, so failures log + fall through
  // to the purchase path.
  const provisioned = await acquireVps({
    businessId,
    tier: narrowTier,
    vpsSize,
    vpsProvider,
    billingPeriod: input.billingPeriod ?? null,
    hostingerTerm: input.hostingerTerm ?? null,
    skipPoolAdopt: input.skipPoolAdopt ?? false,
    vpsPool,
    vpsAdopter,
    vpsProvisioner,
    reconcileOrphans: orphanReconciler,
    /* c8 ignore next 4 -- production default closure; tests inject resolvePaidThrough */
    resolvePaidThrough:
      deps?.resolvePaidThrough ??
      ((billingSubscriptionId) =>
        resolvePaidThroughForBillingSub(hostinger, billingSubscriptionId, { businessId })),
    countAssignedFor: deps?.countAssignedFor,
    sleep: deps?.sleep,
    now: deps?.now
  });
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
    : "Bootstrapping VPS over SSH (PIS not eligible, running full bootstrap)";

  await recordProvisioningProgress({
    businessId,
    phase: "vps_bootstrapping",
    percent: 17,
    message: bootstrapMessage,
    source: "orchestrator"
  });

  // When a post-install script IS attached, Hostinger's own runner is
  // executing it on the box right now, and `cloud-init status --wait` cannot
  // see that runner. Let it finish before running the same bootstrap over
  // SSH. See `waitForPostInstallQuiescence` for the measurements.
  //
  // On a box whose PIS already finished (or never ran) the probe answers
  // "idle" on the first round trip, so the cost is one SSH exec. The adopt
  // path does its own wait before handing the host over, which makes this a
  // no-op there rather than a double wait.
  if (provisioned.postInstallScriptId !== null) {
    const quiescence = await waitForPostInstallQuiescence({
      host: provisioned.publicIp,
      username: provisioned.sshUsername,
      privateKeyPem: provisioned.sshKey.private_key_pem,
      sshKeyRow: provisioned.sshKey,
      remoteExec,
      sleep: deps?.sleep,
      now: deps?.now
    });
    if (quiescence !== "idle") {
      // Both non-idle outcomes continue to the bootstrap, which is the step
      // allowed to fail the provision and the one whose error message names
      // the real problem. Logged so a post-mortem can tell "we waited out the
      // budget" from "the key was never on the box".
      logger.warn("post-install quiescence wait did not reach idle; bootstrapping anyway", {
        businessId,
        vpsId,
        postInstallScriptId: provisioned.postInstallScriptId,
        outcome: quiescence
      });
    }
  }

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
    vpsSize,
    remoteExec,
    // Host-key pinning (G7): this first connection captures the box's
    // fingerprint onto the key row; the deploy call below then verifies
    // strictly against it.
    sshKeyRow: provisioned.sshKey,
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

  // Persist the RESOLVED hardware pin, only now, AFTER updateBusinessStatus
  // pointed hostinger_vps_id at the new box, so the pin and the referenced VM
  // never disagree (a pin written at acquire time would describe the NEW box
  // while hostinger_vps_id still referenced the old one, letting a fleet
  // redeploy push a kvm1 no-Ollama profile onto live kvm2 hardware). Runtime
  // consumers (e.g. the SMS worker's over-cap local-model check) key off the
  // explicit `businesses.vps_size` and treat null as "legacy kvm2/kvm8 with
  // Ollama", so every box provisioned from here on must carry its actual
  // size. The write is FATAL on failure, exactly like the updateBusinessStatus
  // call above (same table, same client): a kvm1 box silently left unpinned
  // would be treated as legacy hardware, over-cap SMS would route to an
  // Ollama that doesn't exist and fleet redeploys would push a kvm2 profile
  // onto it, which is worse than surfacing the error and letting the
  // provision retry.
  await updateBusinessVpsSize(businessId, vpsSize);

  // `businessRow` was loaded once at the top of this orchestrator (provider
  // resolution); none of the fields consumed below (business_type, tier,
  // phone, data_residency_mode) change during a provision run.
  const existingConfig = await getBusinessConfig(businessId);
  await upsertBusinessConfig({
    business_id: businessId,
    soul_md:
      existingConfig?.soul_md ??
      loadSoulTemplate(
        businessRow?.business_type,
        businessRow?.tier === "enterprise"
          ? parseComplianceModule(
              (businessRow as { compliance_module?: unknown }).compliance_module
            )
          : null
      ),
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
  // abort the deploy, the dashboard's mailbox route also self-heals via
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
  // is the business UUID, ONE level under the zone, so Universal SSL
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
  // The AiFlow render sidecar (headless Chromium) is an ENTITLEMENT gate:
  // standard/enterprise get it, starter does not, regardless of hardware
  // (the June 2026 KVM2 experiment validated render runs fine on a KVM2 box,
  // so a standard tenant pinned to kvm2 still gets the sidecar). Gate the
  // public render hostname to match where the container actually runs.
  const renderEnabled = narrowTier !== "starter";
  // Residency data-api gate. Keys on the REAL tier from the business row
  // (narrowTier collapses enterprise onto the standard box profile) plus the
  // enterprise-only data_residency_mode flag: only an opted-in enterprise
  // tenant gets the data-* hostname and the on-box datastore stack.
  const dataResidencyEnabled =
    businessRow?.tier === "enterprise" &&
    (businessRow?.data_residency_mode ?? "supabase") !== "supabase";
  if (tunnelProvisioner) {
    try {
      const p = await tunnelProvisioner({
        businessId,
        renderEnabled,
        dataEnabled: dataResidencyEnabled
      });
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
  // recorded as an error log but does not abort the deploy, the operator can
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
          // "", spreading that would clobber the `undefined` default,
          // bypass the `?? null` fallback downstream, and persist "" into
          // telnyx_voice_routes.media_wss_origin, producing a malformed
          // wss:// URL for the inbound-voice edge function.
          ...(bridgeMediaWssOrigin ? { bridgeMediaWssOrigin } : {})
        };
        // Hard-stop before placing a real number order if the platform
        // doesn't have a Call Control connection_id and/or messaging
        // profile id. Ordering without these silently produces an
        // unwired DID that costs money and can't carry calls (root
        // cause of the May 2026 "call could not be completed" outage,
        // number was active in Telnyx, but `connection_id: ""` left
        // inbound webhooks with nowhere to go). Failing here surfaces
        // the config gap as a deploy-time error instead of a silent
        // production regression at first call.
        assertPlatformTelnyxDefaults(platformDefaults);

        // Non-US tenants ride their country's messaging profile (the
        // destination country must be whitelisted on the profile or every
        // outbound SMS fails with Telnyx 40309, the Truly Insurance
        // incident). The same resolution gates the labeled country
        // surcharges at checkout, so capability and fee travel together.
        // Mexican tenants keep a US DID in v1 (no +52 purchase), but their
        // texts terminate at +52 numbers, so the profile is what carries
        // the capability.
        const tenantCountry = resolveBusinessCountry({
          phone: businessRow?.phone ?? null,
          timezone: businessRow?.timezone ?? null
        });
        const canadianTenant = tenantCountry === "CA";
        if (tenantCountry !== "US") {
          const profileEnvKey =
            tenantCountry === "CA"
              ? "TELNYX_MESSAGING_PROFILE_ID_CA"
              : "TELNYX_MESSAGING_PROFILE_ID_MX";
          const countryProfileId = (process.env[profileEnvKey] ?? "").trim();
          if (countryProfileId) {
            platformDefaults.messagingProfileId = countryProfileId;
          } else {
            // Fee may already be charged at checkout, surface the config gap
            // loudly instead of silently provisioning a tenant whose texts to
            // their own country will bounce.
            logger.warn(
              `${tenantCountry} tenant provisioned WITHOUT ${profileEnvKey}; outbound SMS to ${tenantCountry} will fail until the profile is fixed`,
              { businessId }
            );
          }
        }

        // Dedicated per-tenant Telnyx voice infra: create (or adopt) the
        // tenant's own Call Control app + outbound voice profile BEFORE the
        // number order, and point the order's connection at it, so the DID
        // lands on carrier infrastructure whose channel limits match the
        // tenant's plan instead of the shared fleet-wide pool. Failure
        // degrades to the shared platform app (never aborts provisioning);
        // scripts/oneshot/migrate-tenants-to-dedicated-telnyx-apps.ts
        // converges stragglers, and re-runs adopt rather than duplicate.
        const tenantVoiceInfra =
          deps?.tenantVoiceInfra === null
            ? null
            : deps?.tenantVoiceInfra ?? defaultTenantVoiceInfraProvisioner();
        if (tenantVoiceInfra) {
          try {
            const voiceTier = String(businessRow?.tier ?? "starter");
            const infra = await tenantVoiceInfra({
              businessId,
              businessName: String(businessRow?.name ?? "Tenant"),
              maxConcurrentCalls: resolveTenantMaxConcurrentCalls(
                voiceTier,
                businessRow?.enterprise_limits ?? null
              )
            });
            // Persist BOTH ids BEFORE adopting the override: if this write
            // throws, the catch's "riding the shared platform app" claim
            // below stays true (the override was never applied) and the
            // settings row can never name a different app than the one the
            // order used. If the DID order later fails, the cached tenant
            // ids sit inert (no route row = no calls) and stay correct for
            // the retry or the migration one-shot.
            await upsertBusinessTelnyxSettings({
              businessId,
              telnyxConnectionId: infra.connectionId,
              telnyxOutboundVoiceProfileId: infra.outboundVoiceProfileId
            });
            platformDefaults.connectionId = infra.connectionId;
            try {
              await recordProvisioningProgress({
                businessId,
                phase: "tenant_voice_infra",
                percent: 36,
                message: `Dedicated Telnyx voice app + profile ready (${infra.connectionId})`,
                source: "orchestrator"
              });
            } catch (progressErr) {
              // Cosmetic write; the override and the settings already hold,
              // so this must not fall through to the "shared app" catch.
              logger.warn("tenant_voice_infra progress write failed", {
                businessId,
                error: String(progressErr)
              });
            }
          } catch (infraErr) {
            logger.warn(
              "Tenant voice infra creation failed; DID will ride the shared platform app",
              {
                businessId,
                error: infraErr instanceof Error ? infraErr.message : String(infraErr)
              }
            );
          }
        }

        // Ordered search cascade (see did-search-plan.ts): the area code
        // the owner explicitly REQUESTED at signup, then the NPA derived
        // from their own phone, then the platform default, then any number
        // in the default country. `businessRow` was already loaded above,
        // no second DB round-trip, no risk of a transient re-read silently
        // dropping a valid preference. Each spec carries its own country:
        // the NANP spans US + Canada and Telnyx files inventory per
        // country (a 519/Ontario search under `US` returns nothing, the
        // Jul 8 2026 Truly Insurance signup needed a manual CA-scoped
        // order for exactly this reason).
        const searchPlan = buildDidSearchPlan({
          preferredAreaCode: normalizePreferredAreaCode(businessRow?.preferred_area_code),
          ownerAreaCode: extractNanpAreaCode(businessRow?.phone),
          // A timezone-classified Canadian tenant (non-NANP phone → no NPA
          // tiers) must still land on a Canadian number: the default-country
          // tiers become CA and the US-centric env area/state filters are
          // dropped (a "US area 212" filter under country CA zeroes out
          // inventory). Mexican tenants deliberately take the US branch:
          // v1 keeps them on a US +1 DID (no +52 purchase, no Telnyx
          // regulatory-document plumbing) with WhatsApp as the local
          // channel, and extractNanpAreaCode on a +52 owner phone returns
          // null so the owner_local tier silently (and intentionally)
          // drops out of their cascade.
          defaultCountry: canadianTenant ? "CA" : process.env.TELNYX_DEFAULT_COUNTRY ?? "US",
          defaultAreaCode: canadianTenant ? undefined : process.env.TELNYX_DEFAULT_AREA_CODE,
          defaultState: canadianTenant ? undefined : process.env.TELNYX_DEFAULT_STATE
        });

        let toE164: string | null = null;
        let usedSpec: DidSearchSpec | null = null;
        for (let i = 0; i < searchPlan.length; i += 1) {
          const spec = searchPlan[i];
          try {
            ({ toE164 } = await didProvisioner({
              businessId,
              platformDefaults,
              search: {
                countryCode: spec.countryCode,
                areaCode: spec.areaCode,
                administrativeArea: spec.administrativeArea
              }
            }));
            usedSpec = spec;
            break;
          } catch (orderErr) {
            // Sold-out inventory moves to the next tier; anything else
            // (order failure, Telnyx 5xx, config problems) aborts the DID
            // phase as before. The final `any` spec has no narrower to go,
            // so its no-inventory failure surfaces too.
            if (
              orderErr instanceof OrderAndAssignError &&
              orderErr.reason === "no_numbers_available" &&
              i < searchPlan.length - 1
            ) {
              logger.warn("No DID inventory for search tier; trying next", {
                businessId,
                source: spec.source,
                countryCode: spec.countryCode,
                areaCode: spec.areaCode
              });
              continue;
            }
            throw orderErr;
          }
        }
        /* c8 ignore next 4 -- unreachable: the loop either breaks with both set or throws */
        if (toE164 === null || usedSpec === null) {
          throw new Error("DID search cascade ended without a number or an error");
        }

        await recordProvisioningProgress({
          businessId,
          phase: "did_assigned",
          percent: 38,
          // Only claim a requested/local number when that tier actually
          // produced the purchase, after a fallback the number came from
          // the platform default (or any-country) tier, so don't imply
          // locality.
          message:
            usedSpec.source === "requested"
              ? `Per-tenant DID assigned (${toE164}); requested area code ${usedSpec.areaCode}`
              : usedSpec.source === "owner_local"
                ? `Per-tenant DID assigned (${toE164}); local area code ${usedSpec.areaCode}`
                : `Per-tenant DID assigned (${toE164})`,
          source: "orchestrator"
        });

        // Best-effort 10DLC (A2P SMS) campaign attach. US carriers silently
        // drop A2P SMS from numbers that aren't registered to an approved
        // campaign, the May 2026 SMS outage was exactly this. If 10DLC
        // isn't configured yet, or the shared campaign is still in carrier
        // vetting, we record the per-DID status as `pending` and let the
        // dashboard banner + retry worker pick it up later. NEVER block
        // provisioning on this, the customer's voice + inbound-SMS path
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
          // Including MissingTendlcConfigError, surfaces in progress log
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
  // Per-tenant gateway token: reuse the business's existing (pending or confirmed)
  // token, or mint + persist a fresh PENDING one BEFORE the deploy. The token is
  // the VPS->app bearer, Rowboat's tool-webhook JWT secret, the app->Rowboat API
  // key, AND the in-deploy progress-callback bearer, so its row must exist while
  // deploy-client.sh runs (so progress POSTs authenticate via the inbound
  // binding). It stays PENDING (deployed_at NULL) until the deploy succeeds, so
  // outbound/JWT verification keep using the shared secret the box is still on; we
  // confirm it with markGatewayTokenDeployed only after a successful deploy. A
  // failed deploy leaves the pending token for the next attempt to reuse +
  // redeploy. A DB error aborts provisioning rather than deploying a mismatched
  // shared token.
  const existingGatewayToken = await getActiveGatewayTokenForBusiness(businessId);
  const gatewayToken =
    existingGatewayToken ?? (await issueGatewayToken(businessId, { label: "provisioning" }));
  // Residency data-api bearer list: EVERY non-revoked token (pending +
  // confirmed), not just the one this deploy stamps, during a rotation the
  // platform can still present the old confirmed token until
  // markGatewayTokenDeployed flips it, and the data-api must keep answering
  // through that overlap. Only resolved for residency-enabled tenants.
  let dataApiTokens = "";
  let residencyBackupPassphrase = "";
  // Where the box's encrypted dumps go: 'central' (ciphertext to central
  // Storage) or 'onbox' (dumps stay on the box, in-region even for
  // ciphertext, per Canadian/insurance deals). Only meaningful when the
  // residency stack is enabled.
  const residencyBackupDestination =
    businessRow?.residency_backup_destination === "onbox" ? "onbox" : "central";
  if (dataResidencyEnabled) {
    const activeTokens = await listActiveGatewayTokensForBusiness(businessId);
    const all = activeTokens.includes(gatewayToken)
      ? activeTokens
      : [gatewayToken, ...activeTokens];
    dataApiTokens = all.join(",");
    // AES passphrase for the box's encrypted datastore dumps
    // (residency_backup_keys). Minted once per tenant; only ciphertext
    // ever leaves the box. Empty for customer_held custody, the deploy
    // then uninstalls the platform backup timer (customer owns DR).
    residencyBackupPassphrase = await resolveResidencyBackupPassphraseForDeploy(businessId);
  }
  // Designated models + voice (enterprise): per-tenant overrides win over
  // the platform env defaults; validated by parseEnterpriseModels (garbage
  // or a non-enterprise tier falls back to platform defaults).
  const modelOverrides =
    businessRow?.tier === "enterprise"
      ? parseEnterpriseModels(
          (businessRow as { enterprise_models?: unknown }).enterprise_models
        )
      : null;
  const bashQuote = deps?.quoteEnv ?? quoteShellEnvValue;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const progressUrl = `${appUrl.replace(/\/$/, "")}/api/provisioning/progress`;
  // Bind the progress token to the per-tenant gateway token (when no explicit
  // override is set) so /api/provisioning/progress's per-tenant binding matches
  // the now-persisted token. No new secret is placed on the box: the per-tenant
  // token is already its ROWBOAT_GATEWAY_TOKEN.
  const progressToken = process.env.PROVISIONING_PROGRESS_TOKEN ?? gatewayToken;

  const envVars = [
    ["BUSINESS_ID", businessId],
    ["TIER", narrowTier],
    // Hardware profile for deploy-client.sh (Ollama model selection). The
    // aiflow-render gate stays keyed on TIER, standard/enterprise get the
    // render sidecar regardless of box size.
    ["VPS_SIZE", vpsSize],
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
    ["GEMINI_LIVE_MODEL", modelOverrides?.geminiLiveModel ?? process.env.GEMINI_LIVE_MODEL ?? ""],
    // Prebuilt Gemini Live voice. This is now only a per-BOX ops override: the
    // tenant's own choice lives in `business_telnyx_settings.voice_name` and is
    // read per call by the bridge, so it needs no redeploy. Blank falls through
    // to the platform default (Kore) in the bridge.
    ["VOICE_NAME", process.env.VOICE_NAME ?? ""],
    ["GEMINI_LIVE_ENABLED", process.env.GEMINI_LIVE_ENABLED ?? ""],
    // Rollout flag for Gemini Live transcript capture. Read by the voice
    // bridge (vps/voice-bridge/src/index.ts); when "true" it attaches the
    // Supabase transcript adapter and persists caller/assistant turn rows
    // into voice_call_transcript_turns. Default-off so tenants opt in by
    // setting the var on Vercel and re-running provisioning.
    ["VOICE_TRANSCRIPTION_ENABLED", process.env.VOICE_TRANSCRIPTION_ENABLED ?? ""],
    // Optional per-box Gemini Live session cap (ms). Blank keeps whatever is
    // already in the box's /opt/voice-bridge/.env (preserve-existing ladder in
    // deploy-client.sh), else the bridge's 14-min default. Used by the HQ demo
    // line to pin a 5-minute cap that survives fleet redeploys.
    ["GEMINI_LIVE_SESSION_MAX_MS", process.env.GEMINI_LIVE_SESSION_MAX_MS ?? ""],
    // Model name Rowboat uses for the voice_task agent via the llm-router
    // sidecar. Falls back to the deploy-client.sh default when unset.
    ["GEMINI_ROWBOAT_MODEL", process.env.GEMINI_ROWBOAT_MODEL ?? ""],
    // Model Rowboat's OwnerCoworker (owner dashboard chat) agent uses via the
    // llm-router. Mirrors GEMINI_ROWBOAT_MODEL so setting it on Vercel actually
    // reaches the VPS seed; blank lets deploy-client.sh apply its default
    // (gemini-2.5-flash-lite, which itself falls back to local without a key).
    ["OWNER_CHAT_MODEL", modelOverrides?.ownerChatModel ?? process.env.OWNER_CHAT_MODEL ?? ""],
    // Model for the Coworker (inbound customer SMS) agent; deploy-client.sh
    // applies its own default when blank.
    ["SMS_CHAT_MODEL", modelOverrides?.smsChatModel ?? process.env.SMS_CHAT_MODEL ?? ""],
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
    // Residency data-api stack gate for deploy-client.sh: "true" stands the
    // per-tenant Postgres + data-api containers up (enterprise, opted in);
    // anything else tears a stale stack down.
    ["DATA_RESIDENCY_ENABLED", dataResidencyEnabled ? "true" : ""],
    // Comma-separated bearer list for the data-api (all non-revoked tokens,
    // so a rotation's overlap window never drops authenticated requests).
    ["DATA_API_TOKENS", dataApiTokens],
    // Backup-encryption passphrase (empty when residency is off OR custody
    // is customer_held, deploy-client then skips/uninstalls the backup timer).
    ["RESIDENCY_BACKUP_PASSPHRASE", residencyBackupPassphrase],
    // 'central' uploads ciphertext to central Storage; 'onbox' keeps dumps
    // on the box (in-region even for ciphertext).
    ["RESIDENCY_BACKUP_DESTINATION", residencyBackupDestination],
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
    message: "Starting deploy-client.sh on VPS (detached SSH + poll)",
    source: "orchestrator"
  });

  // Phase 4: detach deploy-client.sh under nohup (script owns flock) and
  // poll the exit file / terminal progress. Survives Vercel killing the
  // long SSH; watchdog can attach to the same in-flight deploy.
  let deploySucceeded = false;
  // Captured for the ops deploy-failed alert below: which failure site fired
  // and what it said. Progress rows carry the same text, but the notify block
  // shouldn't have to re-read them.
  // Overwritten by whichever failure site fires; the defaults are never
  // sent (the notify branch only reads them when deploySucceeded is false,
  // and both failure paths assign first).
  let deployFailurePhase = "deploy_failed";
  let deployFailureReason = "(no failure detail captured)";
  /* c8 ignore next -- production default; tests inject latestProvisioningStatus */
  const latestStatus =
    deps?.latestProvisioningStatus ?? getLatestProvisioningStatus;
  try {
    const deployResult = await runDetachedDeployClient({
      businessId,
      envVars,
      host: provisioned.publicIp,
      username: provisioned.sshUsername,
      privateKeyPem: provisioned.sshKey.private_key_pem,
      // Verifies strictly against the fingerprint the bootstrap connect
      // captured above (sshExecPinned updates the row object in place).
      sshKeyRow: provisioned.sshKey,
      remoteExec,
      latestProvisioningStatus: latestStatus,
      // Computed HERE, not by the caller: purchase, boot and SSH bootstrap all
      // happen between the caller's start and this poll, and they are the bulk
      // of the pre-deploy time.
      deadlineMs: deployDeadlineForBudget(input.deployBudgetStartedAtMs, nowMs),
      sleep: deps?.sleep,
      now: deps?.now
    });
    if (!deployResult.ok) {
      logger.error("deploy-client.sh failed", {
        businessId,
        vpsId,
        reason: deployResult.reason,
        exitCode: deployResult.exitCode
      });
      deployFailurePhase = "deploy_failed";
      deployFailureReason = deployResult.reason;
      await recordProvisioningProgress({
        businessId,
        phase: "deploy_failed",
        percent: 95,
        message: deployResult.reason.slice(0, 2000),
        source: "orchestrator",
        status: "error"
      });
    } else {
      deploySucceeded = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Remote deploy SSH failed: VPS may need manual setup", {
      businessId,
      vpsId,
      error: msg
    });
    deployFailurePhase = "deploy_exception";
    deployFailureReason = msg;
    await recordProvisioningProgress({
      businessId,
      phase: "deploy_exception",
      percent: 95,
      message: msg,
      source: "orchestrator",
      status: "error"
    });
  }

  // Now that the box actually carries the token, confirm it: this is what flips
  // outbound/JWT verification over to the per-tenant secret and revokes any older
  // token. Done only on a successful deploy so the DB never gets ahead of the VPS.
  //
  // A confirm failure here is NON-fatal: the deploy already succeeded and the box is
  // serving the new (still-pending) secret, so inbound tool-call JWTs already verify
  // (resolveRowboatWebhookClaims accepts pending tokens). Throwing would abort before
  // `updateBusinessStatus` and leave the tenant stuck. Instead we log + record the
  // warning and continue; outbound app→Rowboat keeps using the prior confirmed token
  // until the next (idempotent) reprovision re-runs the confirm. The token row stays
  // pending and is reused, so nothing is lost.
  if (deploySucceeded) {
    try {
      await markGatewayTokenDeployed(businessId, gatewayToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("markGatewayTokenDeployed failed after a successful deploy", {
        businessId,
        vpsId,
        error: msg
      });
      await recordProvisioningProgress({
        businessId,
        phase: "gateway_token_confirm_failed",
        percent: 96,
        message: `Gateway token confirm failed (deploy OK, token left pending for reprovision): ${msg}`,
        source: "orchestrator",
        status: "error"
      });
    }
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

  const freshBusiness = await getBusiness(businessId);
  const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const dashboardUrl = `${siteUrl}/dashboard`;

  // Background hardware migrations set suppressOwnerNotify so an existing
  // customer is not emailed/texted "Your New Coworker is live!" as if they
  // just signed up. Ops alerts below are independent of this flag.
  let notifyEmail: string | null = null;
  if (input.suppressOwnerNotify) {
    logger.info("Skipping provisioning owner email/SMS (suppressOwnerNotify)", { businessId });
  } else if (!deploySucceeded) {
    // "Your New Coworker is live!" has to be true when it arrives, so the
    // owner notice stays suppressed (decision: admin-only alerting, Aug
    // 2026). But nothing else tells a human either: the ops new-signup
    // alert below is gated on deploySucceeded, a signup job is marked
    // succeeded on a normal return so the watchdog never retries it, and
    // the stuck scan excludes error-status progress rows from its band
    // check (isStuckProgressBand). This direct ops email is therefore the
    // ONLY notification a failed signup deploy produces. Fire-and-forget:
    // the sender never throws.
    logger.warn("Skipping provisioning owner email/SMS: deploy did not succeed", {
      businessId,
      vpsId
    });
    await sendOpsDeployFailedEmail({
      businessId,
      businessName: freshBusiness?.name ?? "",
      virtualMachineId: vpsId,
      phase: deployFailurePhase,
      reason: deployFailureReason
    });
  } else {
    notifyEmail = resolveOwnerNotifyEmail(ownerEmail, freshBusiness?.owner_email);
    // Recipient: the OWNER's phone, the explicit caller override first, then
    // the phone the owner gave at onboarding (coerced: it's free-form input,
    // e.g. "5145188192"), then the platform ops phone as the last-resort
    // fallback (admin-driven provisions with no owner phone on file).
    const notifyPhone =
      coerceOwnerPhoneToE164(ownerPhone) ??
      coerceOwnerPhoneToE164(businessRow?.phone) ??
      process.env.TELNYX_OWNER_PHONE;

    if (notifyEmail) {
      try {
        const ownerLocale = await resolveOwnerUiLocaleForEmail(notifyEmail);
        const { subject, text, html } = buildProvisioningLiveEmail({
          dashboardUrl,
          siteUrl,
          recipientEmail: notifyEmail,
          locale: ownerLocale
        });
        await sendOwnerEmail(process.env.RESEND_API_KEY ?? "", notifyEmail, subject, { text, html });
      } catch (err) {
        logger.warn("Failed to send provisioning email", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } else {
      logger.warn("Skipping provisioning owner email: no reachable owner email on file", {
        businessId
      });
    }

    if (notifyPhone) {
      try {
        // Sender: the tenant's OWN new DID, their first text from their own
        // business number. The platform owns no sender number, so there is
        // deliberately NO env fallback here: falling back to
        // TELNYX_SMS_FROM_E164 once sent this from ANOTHER tenant's business
        // number (Amy's DID, Jul 14 2026, the env value was repointed after
        // the original platform number was released). A tenant whose DID
        // auto-order failed skips with an honest log instead.
        const tenantSettings = await getBusinessTelnyxSettings(businessId);
        const tenantFrom = tenantSettings?.telnyx_sms_from_e164?.trim();
        if (!tenantFrom) {
          logger.warn(
            "Skipping provisioning SMS: tenant has no DID to send from (assign one from admin, no shared sender exists)",
            { businessId }
          );
        } else {
          const cfg = await getTelnyxMessagingForBusiness(businessId);
          const liveSmsBody = `Your New Coworker is live! Dashboard: ${dashboardUrl}`;
          // Metered like every send (nothing is exempt), in operational mode:
          // counted against the pool but never refused at the cap.
          const sent = await sendTelnyxSms(
            { ...cfg, fromE164: tenantFrom },
            notifyPhone,
            liveSmsBody,
            { meterBusinessId: businessId, meterMode: "operational" }
          );
          // Durable log so the owner's first text shows in the dashboard Texts
          // thread like every other owner notice (AiFlow owner_notify does the
          // same). Best-effort: the SMS already went out, a failed insert must
          // not fail provisioning.
          try {
            const db = await createSupabaseServiceClient();
            const { error: logErr } = await db.from("sms_outbound_log").insert({
              business_id: businessId,
              to_e164: notifyPhone,
              from_e164: tenantFrom,
              body: liveSmsBody,
              source: "owner_notify",
              telnyx_message_id: sent.id,
              channel: sent.channel
            });
            if (logErr) throw new Error(logErr.message);
          } catch (logErr) {
            logger.warn("Provisioning SMS sent but outbound log insert failed", {
              businessId,
              error: logErr instanceof Error ? logErr.message : String(logErr)
            });
          }
        }
      } catch (err) {
        logger.warn("Failed to send provisioning SMS", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  if (shouldSendOpsNewSignupAlert && deploySucceeded) {
    let didRoute = null;
    try {
      didRoute = await getTelnyxVoiceRouteForBusiness(businessId);
    } catch {
      // Ops email is best-effort; a route lookup hiccup must not affect provisioning.
    }
    let subscription = null;
    try {
      subscription = await getSubscription(businessId);
    } catch {
      // Same best-effort posture as the DID lookup above.
    }
    const sent = await sendOpsNewSignupEmail({
      businessId,
      businessName: freshBusiness?.name ?? businessRow?.name ?? "",
      ownerName: freshBusiness?.owner_name ?? businessRow?.owner_name ?? null,
      ownerEmail: notifyEmail,
      ownerPhone: freshBusiness?.phone ?? businessRow?.phone ?? null,
      tier: freshBusiness?.tier ?? businessRow?.tier ?? narrowTier,
      billingPeriod: subscription?.billing_period ?? input.billingPeriod ?? null,
      virtualMachineId: vpsId,
      didE164: didRoute?.to_e164 ?? null
    });
    if (sent) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await recordProvisioningProgress({
            businessId,
            phase: "ops_new_signup_alert_sent",
            percent: 100,
            message: "Ops new-signup alert sent",
            source: "orchestrator",
            status: "success"
          });
          break;
        } catch (err) {
          if (attempt === 2) {
            logger.warn("Failed to record ops new-signup alert sent after retries", {
              businessId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }
    }
  }

  if (provisioned.hostingerBillingSubscriptionId) {
    try {
      await persistHostingerBillingIdOnLiveSubscription(
        businessId,
        provisioned.hostingerBillingSubscriptionId
      );
    } catch (err) {
      logger.warn("Failed to persist hostinger_billing_subscription_id", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    vpsId,
    tunnelUrl,
    hostingerBillingSubscriptionId: provisioned.hostingerBillingSubscriptionId,
    deploySucceeded
  };
}
