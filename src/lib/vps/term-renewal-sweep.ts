/**
 * Fleet term-renewal sweep (cron): before a Stripe-backed tenant's Hostinger
 * box renews at full price, buy a fresh term-priced box when the live catalog
 * first-period price undercuts renewal by at least 10%, then migrate the
 * tenant onto it. The old box is pooled with auto-renew off and
 * `never_renew: true`.
 *
 * Safety: at most one migration per run; skip businesses with a hardware
 * migration lease; keep the old box renewing until cutover succeeds.
 * All dependencies are injected; the internal route wires production
 * implementations.
 */

import { logger } from "@/lib/logger";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";
import type { BillingSubscription, CatalogItem, HostingerClient, VirtualMachine } from "@/lib/hostinger/client";
import {
  hostingerTermForBillingPeriod,
  vpsPriceItemId
} from "@/lib/hostinger/provision";
import type { BillingPeriod } from "@/lib/plans/tier";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { sharedHardwareFor } from "@/lib/vps/shared-hardware";
import { resolveDeployedVpsSize, vpsSizeFromHostingerPlan, type VpsSize } from "@/lib/vps/size";
import type { OpsHardwareMigrationInput } from "@/lib/email/templates/ops-hardware-migration";
import {
  enqueueProvisioningJob,
  markProvisioningJobOutcome,
  runProvisioningJob,
  type EnqueueProvisioningJobInput,
  type RunProvisioningJobDeps
} from "@/lib/provisioning/jobs";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";
import { tryRecoverDeployCompleteNewBox } from "@/lib/vps/migration-cutover-recovery";
import { sshExec } from "@/lib/hostinger/ssh";

const DEFAULT_SAVINGS_THRESHOLD = 0.1;
const DEFAULT_RENEWAL_WINDOW_DAYS = 30;
const SWEEP_REQUESTED_BY = "term-renewal-sweep";

export type TermRenewalSweepFinding = {
  kind:
    | "skipped_economics"
    | "skipped_guard"
    | "skipped_in_flight"
    | "migrated"
    | "migration_failed";
  businessId: string;
  businessName: string;
  vmId: number;
  nextBillingAt: string | null;
  detail: string;
  /** Present when economics were evaluated. */
  savingsRatio?: number;
};

export type TermRenewalSweepResult = {
  checked: number;
  skippedEconomics: number;
  migrated: number;
  findings: TermRenewalSweepFinding[];
};

export type TermRenewalSweepOptions = {
  savingsThreshold?: number;
  renewalWindowDays?: number;
  now?: Date;
};

export type TermRenewalSweepDeps = {
  listBusinesses: () => Promise<BusinessRow[]>;
  listBusinessIdsWithLiveSubscription: (
    businessIds: string[]
  ) => Promise<{ stripeBacked: Set<string>; stripeless: Set<string> }>;
  listSubscriptionsByBusinessIds: (businessIds: string[]) => Promise<Map<string, SubscriptionRow>>;
  listCatalog: () => Promise<CatalogItem[]>;
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
  hasActiveVpsMigrationLock: (businessId: string) => Promise<boolean>;
  tryClaimVpsMigration: (businessId: string, requestedBy: string, targetSize: string) => Promise<boolean>;
  releaseVpsMigrationLock: (businessId: string) => Promise<void>;
  getBusiness: (id: string) => Promise<BusinessRow | null>;
  getSubscription: (businessId: string) => Promise<SubscriptionRow | null>;
  updateSubscription: (
    id: string,
    update: { hostinger_billing_subscription_id: string }
  ) => Promise<unknown>;
  getActiveVpsSshKey: (vpsId: string) => Promise<VpsSshKeyRow | null>;
  hostinger: Pick<
    HostingerClient,
    | "getVirtualMachine"
    | "createSnapshot"
    | "stopVirtualMachine"
    | "listBillingSubscriptions"
    | "disableBillingAutoRenewal"
  >;
  backupBusinessData: (
    input: { businessId: string; vpsHost: string },
    deps?: { sshKeyLookup?: (businessId: string) => Promise<VpsSshKeyRow | null> }
  ) => Promise<{ storagePath: string; sizeBytes: number; sha256: string }>;
  restoreBusinessData: (input: { businessId: string; vpsHost: string }) => Promise<unknown>;
  orchestrateProvisioning: (input: {
    businessId: string;
    tier: "starter" | "standard" | "enterprise";
    vpsSize: VpsSize;
    billingPeriod?: SubscriptionRow["billing_period"];
    skipPoolAdopt?: boolean;
    suppressOwnerNotify?: boolean;
  }) => Promise<{ vpsId: string; hostingerBillingSubscriptionId: string | null }>;
  /** Injected so unit tests can skip the real provisioning_jobs ledger. */
  enqueueProvisioningJob?: (input: EnqueueProvisioningJobInput) => Promise<void>;
  runProvisioningJob?: typeof runProvisioningJob;
  /** Marks the ledger succeeded only after cutover finishes. */
  markProvisioningJobOutcome?: typeof markProvisioningJobOutcome;
  /**
   * When provision throws, probe whether the new box is already deploy-complete
   * so cutover can continue. Tests inject a stub; production uses the shared
   * recovery helper.
   */
  tryRecoverDeployCompleteNewBox?: typeof tryRecoverDeployCompleteNewBox;
  releaseVpsToPool: (input: {
    vmId: number;
    plan: VpsSize;
    hostingerBillingSubscriptionId?: string | null;
    notes?: string | null;
  }) => Promise<void>;
  markVpsNeverRenew: (vmId: number) => Promise<void>;
  sendOpsEmail: (input: Omit<OpsHardwareMigrationInput, "siteUrl">) => Promise<void>;
};

type SweepCandidate = {
  business: BusinessRow;
  vmId: number;
  vpsSize: VpsSize;
  subscription: SubscriptionRow;
  billingSub: BillingSubscription;
  nextBillingAt: string;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message: String(err);
}

function tenantVmId(business: BusinessRow): number | null {
  if (!providerUsesHostingerLifecycle(resolveVpsProvider(business.vps_provider))) return null;
  const vmId = Number.parseInt(business.hostinger_vps_id ?? "", 10);
  return Number.isFinite(vmId) && vmId > 0 ? vmId: null;
}

/** First-period cents from a catalog price row (`first_period_price ?? price`). */
export function catalogFirstPeriodCents(price: { price: number; first_period_price?: number }): number {
  return price.first_period_price ?? price.price;
}

/** Savings ratio: (renewal - first) / renewal. Zero when renewal is non-positive. */
export function renewalSavingsRatio(renewalCents: number, firstPeriodCents: number): number {
  if (renewalCents <= 0) return 0;
  return (renewalCents - firstPeriodCents) / renewalCents;
}

export function meetsRenewalSavingsThreshold(
  renewalCents: number,
  firstPeriodCents: number,
  threshold = DEFAULT_SAVINGS_THRESHOLD
): boolean {
  return renewalSavingsRatio(renewalCents, firstPeriodCents) >= threshold;
}

/** Resolve the catalog first-period price for a size at the tenant's contract term. */
export function findCatalogFirstPeriodCents(
  catalog: CatalogItem[],
  size: VpsSize,
  billingPeriod: BillingPeriod
): number | null {
  const itemId = vpsPriceItemId(size, hostingerTermForBillingPeriod(billingPeriod));
  for (const item of catalog) {
    const price = item.prices.find((p) => p.id === itemId);
    if (price) return catalogFirstPeriodCents(price);
  }
  return null;
}

/** True when `nextBillingAt` falls between `now` and `now + windowDays`. */
export function isWithinRenewalWindow(
  nextBillingAt: string,
  now: Date,
  windowDays = DEFAULT_RENEWAL_WINDOW_DAYS
): boolean {
  const next = new Date(nextBillingAt);
  if (Number.isNaN(next.getTime())) return false;
  const diffMs = next.getTime() - now.getTime();
  if (diffMs < 0) return false;
  return diffMs <= windowDays * 24 * 60 * 60 * 1000;
}

function resolveBillingSub(
  subscription: SubscriptionRow,
  vm: VirtualMachine,
  subsById: Map<string, BillingSubscription>
): BillingSubscription | null {
  // Partial cutover is rejected earlier via isPartialTermCutover; by the time
  // we resolve, the row and VM billing ids either agree or one side is missing.
  const fromSubRow = subscription.hostinger_billing_subscription_id
    ? subsById.get(subscription.hostinger_billing_subscription_id) ?? null
    : null;
  if (fromSubRow) return fromSubRow;
  if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
    return subsById.get(vm.subscription_id) ?? null;
  }
  return null;
}

/** True when the live VM's billing id disagrees with the subscription row. */
export function isPartialTermCutover(
  subscription: Pick<SubscriptionRow, "hostinger_billing_subscription_id">,
  vm: Pick<VirtualMachine, "subscription_id">
): boolean {
  const rowId = subscription.hostinger_billing_subscription_id;
  const vmId = typeof vm.subscription_id === "string" ? vm.subscription_id : null;
  return Boolean(rowId && vmId && rowId !== vmId);
}

function nextBillingTimestamp(sub: BillingSubscription): string | null {
  return sub.next_billing_at ?? sub.expires_at ?? null;
}

export async function runTermRenewalSweep(
  deps: TermRenewalSweepDeps,
  options: TermRenewalSweepOptions = {}
): Promise<TermRenewalSweepResult> {
  const now = options.now ?? new Date();
  const savingsThreshold = options.savingsThreshold ?? DEFAULT_SAVINGS_THRESHOLD;
  const renewalWindowDays = options.renewalWindowDays ?? DEFAULT_RENEWAL_WINDOW_DAYS;

  const [businesses, catalog, billingSubs] = await Promise.all([
    deps.listBusinesses(),
    deps.listCatalog(),
    deps.listBillingSubscriptions()
  ]);
  const subsById = new Map(billingSubs.map((sub) => [sub.id, sub]));

  const hostingerCandidates = businesses
    .map((business) => ({ business, vmId: tenantVmId(business) }))
    .filter(
      (entry): entry is { business: BusinessRow; vmId: number } =>
        entry.vmId !== null && entry.business.status !== "wiped"
    );

  const liveIds = await deps.listBusinessIdsWithLiveSubscription(
    hostingerCandidates.map((entry) => entry.business.id)
  );
  const stripeBacked = hostingerCandidates.filter((entry) =>
    liveIds.stripeBacked.has(entry.business.id)
  );

  const subByBusiness = await deps.listSubscriptionsByBusinessIds(
    stripeBacked.map((entry) => entry.business.id)
  );

  const findings: TermRenewalSweepFinding[] = [];
  const candidates: SweepCandidate[] = [];
  for (const { business, vmId } of stripeBacked) {
    const subscription = subByBusiness.get(business.id);
    if (!subscription || subscription.status !== "active") continue;
    if (!subscription.billing_period) continue;

    let vm: VirtualMachine;
    try {
      vm = await deps.hostinger.getVirtualMachine(vmId);
    } catch (err) {
      logger.warn("term-renewal sweep: VM lookup failed", {
        businessId: business.id,
        vmId,
        error: errMsg(err)
      });
      continue;
    }

    if (isPartialTermCutover(subscription, vm)) {
      findings.push({
        kind: "skipped_guard",
        businessId: business.id,
        businessName: business.name,
        vmId,
        nextBillingAt: null,
        detail:
          "partial cutover detected: businesses.hostinger_vps_id billing id differs from " +
          "subscriptions.hostinger_billing_subscription_id; manual recovery required before retry"
      });
      continue;
    }

    const billingSub = resolveBillingSub(subscription, vm, subsById);
    if (!billingSub) continue;

    const nextBillingAt = nextBillingTimestamp(billingSub);
    if (!nextBillingAt || !isWithinRenewalWindow(nextBillingAt, now, renewalWindowDays)) {
      continue;
    }

    const vpsSize = resolveDeployedVpsSize(business.tier, business.vps_size);
    candidates.push({
      business,
      vmId,
      vpsSize,
      subscription,
      billingSub,
      nextBillingAt
    });
  }

  candidates.sort(
    (a, b) => new Date(a.nextBillingAt).getTime() - new Date(b.nextBillingAt).getTime()
  );

  let skippedEconomics = 0;
  let migrated = 0;

  for (const candidate of candidates) {
    const { business, vmId, vpsSize, subscription, billingSub, nextBillingAt } = candidate;

    // Note: never_renew on an ASSIGNED tenant box is a migration SIGNAL (billing
    // posture nags until we move them off sunk-cost hardware). Do not skip.

    if (await deps.hasActiveVpsMigrationLock(business.id)) {
      findings.push({
        kind: "skipped_in_flight",
        businessId: business.id,
        businessName: business.name,
        vmId,
        nextBillingAt,
        detail: "a hardware migration lease is already held for this business"
      });
      continue;
    }

    const guard = guardCandidate(business);
    if (guard) {
      findings.push({
        kind: "skipped_guard",
        businessId: business.id,
        businessName: business.name,
        vmId,
        nextBillingAt,
        detail: guard
      });
      continue;
    }

    const renewalCents = billingSub.renewal_price ?? billingSub.total_price ?? 0;
    const firstPeriodCents = findCatalogFirstPeriodCents(
      catalog,
      vpsSize,
      subscription.billing_period!
    );
    if (firstPeriodCents === null) {
      skippedEconomics += 1;
      findings.push({
        kind: "skipped_economics",
        businessId: business.id,
        businessName: business.name,
        vmId,
        nextBillingAt,
        detail: `no catalog first-period price for ${vpsSize} at ${subscription.billing_period}`
      });
      continue;
    }

    const savingsRatio = renewalSavingsRatio(renewalCents, firstPeriodCents);
    if (!meetsRenewalSavingsThreshold(renewalCents, firstPeriodCents, savingsThreshold)) {
      skippedEconomics += 1;
      findings.push({
        kind: "skipped_economics",
        businessId: business.id,
        businessName: business.name,
        vmId,
        nextBillingAt,
        savingsRatio,
        detail:
          `renewal $${(renewalCents / 100).toFixed(2)} vs first-period ` +
          `$${(firstPeriodCents / 100).toFixed(2)} saves ${(savingsRatio * 100).toFixed(1)}% ` +
          `(need ${(savingsThreshold * 100).toFixed(0)}%)`
      });
      continue;
    }

    const claimed = await deps.tryClaimVpsMigration(business.id, SWEEP_REQUESTED_BY, vpsSize);
    if (!claimed) {
      findings.push({
        kind: "skipped_in_flight",
        businessId: business.id,
        businessName: business.name,
        vmId,
        nextBillingAt,
        detail: "could not claim migration lease (another migration may have started)"
      });
      continue;
    }

    try {
      const outcome = await migrateTenantTermRenewal(
        {
          businessId: business.id,
          vpsSize,
          savingsRatio,
          nextBillingAt,
          renewalCents,
          firstPeriodCents
        },
        deps
      );
      if (outcome.ok) {
        migrated = 1;
        findings.push({
          kind: "migrated",
          businessId: business.id,
          businessName: business.name,
          vmId,
          nextBillingAt,
          savingsRatio,
          detail: outcome.detail
        });
      } else {
        findings.push({
          kind: "migration_failed",
          businessId: business.id,
          businessName: business.name,
          vmId,
          nextBillingAt,
          savingsRatio,
          detail: outcome.detail
        });
      }
    } finally {
      try {
        await deps.releaseVpsMigrationLock(business.id);
      } catch (releaseErr) {
        logger.warn("term-renewal sweep: migration lock release failed", {
          businessId: business.id,
          error: errMsg(releaseErr)
        });
      }
    }
    break;
  }

  return {
    checked: candidates.length,
    skippedEconomics,
    migrated,
    findings
  };
}

function guardCandidate(business: BusinessRow): string | null {
  const vpsProvider = resolveVpsProvider(business.vps_provider);
  if (!providerUsesHostingerLifecycle(vpsProvider)) {
    return `vps_provider=${vpsProvider}: term-renewal sweep is Hostinger-only`;
  }
  const residencyMode = business.data_residency_mode ?? "supabase";
  if (residencyMode !== "supabase") {
    return `data_residency_mode=${residencyMode}: migration would strand the box datastore`;
  }
  const shared = sharedHardwareFor(business.id);
  if (shared) {
    return `${shared.businessName} runs on shared hardware (VM ${shared.vmId})`;
  }
  return null;
}

type MigrateOutcome = { ok: true; detail: string } | { ok: false; detail: string };

async function migrateTenantTermRenewal(
  input: {
    businessId: string;
    vpsSize: VpsSize;
    savingsRatio: number;
    nextBillingAt: string;
    renewalCents: number;
    firstPeriodCents: number;
  },
  deps: TermRenewalSweepDeps
): Promise<MigrateOutcome> {
  const { businessId, vpsSize } = input;

  const biz = await deps.getBusiness(businessId);
  if (!biz) {
    return { ok: false, detail: "business not found" };
  }

  const guard = guardCandidate(biz);
  if (guard) {
    await deps.sendOpsEmail({
      phase: "failed",
      businessId,
      businessName: biz.name,
      requestedBy: SWEEP_REQUESTED_BY,
      fromSize: vpsSize,
      toSize: vpsSize,
      detail: guard
    });
    return { ok: false, detail: guard };
  }

  const tier = biz.tier;
  const sub = await deps.getSubscription(businessId);
  const activeSub = sub && sub.status === "active" ? sub: null;

  const oldVmIdRaw = biz.hostinger_vps_id;
  const oldVmId =
    oldVmIdRaw && /^\d+$/.test(oldVmIdRaw) ? Number.parseInt(oldVmIdRaw, 10): null;
  let oldVmIp: string | null = null;
  let oldBillingId: string | null = activeSub?.hostinger_billing_subscription_id ?? null;

  if (oldVmId !== null) {
    try {
      const vm = await deps.hostinger.getVirtualMachine(oldVmId);
      oldVmIp = vm.ipv4?.[0]?.address ?? null;
      if (!oldBillingId && typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
        oldBillingId = vm.subscription_id;
      }
    } catch (err) {
      logger.warn("term-renewal sweep: old VM lookup failed", { businessId, oldVmId, error: errMsg(err) });
    }
    if (!oldBillingId) {
      try {
        const subs = await deps.hostinger.listBillingSubscriptions();
        oldBillingId = subs.find((s) => s.resource_id === String(oldVmId))?.id ?? null;
      } catch (err) {
        logger.warn("term-renewal sweep: old billing list fallback failed", {
          businessId,
          oldVmId,
          error: errMsg(err)
        });
      }
    }
  }

  const economicsDetail =
    `Renewal $${(input.renewalCents / 100).toFixed(2)} vs fresh first-period ` +
    `$${(input.firstPeriodCents / 100).toFixed(2)} (${(input.savingsRatio * 100).toFixed(1)}% savings). ` +
    `Next billing: ${input.nextBillingAt}.`;

  const notify = async (phase: OpsHardwareMigrationInput["phase"], detail: string): Promise<void> => {
    await deps.sendOpsEmail({
      phase,
      businessId,
      businessName: biz.name,
      requestedBy: SWEEP_REQUESTED_BY,
      fromSize: vpsSize,
      toSize: vpsSize,
      detail
    });
  };

  await notify(
    "started",
    `${economicsDetail} Old box: ${oldVmId !== null ? `srv${oldVmId}`: "none"} (${oldVmIp ?? "no IP"}). ` +
      "Flow: snapshot → backup → fresh term purchase → restore → old-box stop + auto-renew off + pool."
  );

  if (oldVmId === null || !oldVmIp) {
    const detail = "old VM has no resolvable IP: cannot backup; aborting (old box untouched, renew stays ON)";
    await notify("failed", detail);
    return { ok: false, detail };
  }

  const oldBoxKey = await deps.getActiveVpsSshKey(String(oldVmId));
  if (!oldBoxKey || !oldBoxKey.private_key_pem) {
    const detail = `no active SSH key for old VM ${oldVmId}: aborting (old box untouched, renew stays ON)`;
    await notify("failed", detail);
    return { ok: false, detail };
  }

  try {
    await deps.hostinger.createSnapshot(oldVmId);
  } catch (err) {
    logger.warn("term-renewal sweep: snapshot failed (continuing)", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }

  let backupPath: string;
  try {
    const backup = await deps.backupBusinessData(
      { businessId, vpsHost: oldVmIp },
      { sshKeyLookup: async () => oldBoxKey }
    );
    backupPath = backup.storagePath;
  } catch (err) {
    const detail = `backup failed: ${errMsg(err)}: aborting (old box untouched, renew stays ON)`;
    await notify("failed", detail);
    return { ok: false, detail };
  }

  let newProv: { vpsId: string; hostingerBillingSubscriptionId: string | null };
  try {
    /* c8 ignore start -- production ledger defaults; tests inject */
    const enqueue = deps.enqueueProvisioningJob ?? enqueueProvisioningJob;
    const runJob = deps.runProvisioningJob ?? runProvisioningJob;
    /* c8 ignore stop */
    await enqueue({
      businessId,
      tier,
      vpsSize,
      billingPeriod: activeSub?.billing_period ?? null,
      suppressOwnerNotify: true,
      skipPoolAdopt: true,
      purpose: "term_renewal"
    });
    const jobOut = await runJob(
      {
        business_id: businessId,
        tier,
        vps_size: vpsSize,
        billing_period: activeSub?.billing_period ?? null,
        suppress_owner_notify: true,
        skip_pool_adopt: true,
        purpose: "term_renewal"
      },
      {
        orchestrate: async (input) => {
          const out = await deps.orchestrateProvisioning({
            businessId: input.businessId,
            tier: input.tier,
            vpsSize,
            billingPeriod: input.billingPeriod,
            skipPoolAdopt: true,
            suppressOwnerNotify: true
          });
          return {
            hostingerBillingSubscriptionId: out.hostingerBillingSubscriptionId,
            vpsId: out.vpsId
          };
        }
      } satisfies RunProvisioningJobDeps
    );
    if (!jobOut.vpsId) {
      throw new Error("term-renewal provision returned no vpsId");
    }
    newProv = {
      vpsId: jobOut.vpsId,
      hostingerBillingSubscriptionId: jobOut.hostingerBillingSubscriptionId
    };
  } catch (err) {
    /* c8 ignore next -- production default recover factory */
    const recover =
      deps.tryRecoverDeployCompleteNewBox ??
      /* c8 ignore next 12 -- production default recover + SSH probe */
      ((input, probeDeps) =>
        tryRecoverDeployCompleteNewBox(input, {
          ...probeDeps,
          remoteExec: async (args) => {
            const r = await sshExec(args);
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          }
        }));
    const recovered = await recover(
      { businessId, oldVmId },
      {
        getBusiness: deps.getBusiness,
        getLatestProvisioningStatus,
        getVirtualMachine: (id) => deps.hostinger.getVirtualMachine(id),
        getActiveVpsSshKey: deps.getActiveVpsSshKey
      }
    );
    if (recovered) {
      logger.warn(
        "term-renewal sweep: provision threw but new box looks deploy-complete; continuing cutover",
        { businessId, oldVmId, newVpsId: recovered.vpsId, error: errMsg(err) }
      );
      newProv = recovered;
    } else {
      const detail = `provisioning failed: ${errMsg(err)}: old box untouched and still renewing`;
      await notify("failed", detail);
      return { ok: false, detail };
    }
  }

  const newVmId = Number.parseInt(newProv.vpsId, 10);
  let newVmIp: string | null = null;
  try {
    const vm = await deps.hostinger.getVirtualMachine(newVmId);
    newVmIp = vm.ipv4?.[0]?.address ?? null;
  } catch {
    /* handled below */
  }
  if (!newVmIp) {
    const detail =
      `cannot resolve new VM ${newVmId} IP: restore manually (tarball: ${backupPath}); ` +
      "old box left running + renewing";
    await notify("failed", detail);
    return { ok: false, detail };
  }

  try {
    await deps.restoreBusinessData({ businessId, vpsHost: newVmIp });
  } catch (err) {
    const detail =
      `restore failed: ${errMsg(err)}: tarball safe at ${backupPath}; ` +
      "old box left running + renewing (it still has the live data)";
    await notify("failed", detail);
    return { ok: false, detail };
  }

  let newBillingId: string | null = newProv.hostingerBillingSubscriptionId;
  if (!newBillingId) {
    try {
      const vm = await deps.hostinger.getVirtualMachine(newVmId);
      if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
        newBillingId = vm.subscription_id;
      }
    } catch {
      /* fall through */
    }
  }
  if (!newBillingId) {
    try {
      const subs = await deps.hostinger.listBillingSubscriptions();
      newBillingId = subs.find((s) => s.resource_id === String(newVmId))?.id ?? null;
    } catch {
      /* handled below */
    }
  }

  let billingRepointed = !activeSub;
  if (activeSub && newBillingId) {
    try {
      await deps.updateSubscription(activeSub.id, {
        hostinger_billing_subscription_id: newBillingId
      });
      billingRepointed = true;
    } catch (err) {
      logger.error("term-renewal sweep: billing repoint failed", { businessId, error: errMsg(err) });
    }
  }
  if (!billingRepointed) {
    const detail =
      `cutover done (new srv${newVmId} serving) but billing repoint failed: ` +
      "old box left RUNNING + RENEWING. Fix subscriptions.hostinger_billing_subscription_id manually.";
    await notify("failed", detail);
    return { ok: false, detail };
  }

  let oldVmStopped = false;
  try {
    await deps.hostinger.stopVirtualMachine(oldVmId);
    oldVmStopped = true;
  } catch (err) {
    logger.warn("term-renewal sweep: old VM stop failed", { businessId, oldVmId, error: errMsg(err) });
  }

  let oldBillingHandling = "billing-id-unknown-still-renewing";
  if (oldBillingId) {
    try {
      await deps.hostinger.disableBillingAutoRenewal(oldBillingId);
      oldBillingHandling = "auto-renew-disabled";
    } catch (err) {
      oldBillingHandling = "auto-renew-disable-FAILED";
      logger.error("term-renewal sweep: old billing auto-renew disable failed", {
        businessId,
        oldBillingId,
        error: errMsg(err)
      });
    }
  }

  let releasedPlan: VpsSize = vpsSize;
  try {
    const oldVm = await deps.hostinger.getVirtualMachine(oldVmId);
    releasedPlan = vpsSizeFromHostingerPlan(oldVm.plan) ?? vpsSize;
  } catch (err) {
    logger.warn("term-renewal sweep: released-box plan lookup failed", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }

  let pooled = false;
  let neverRenewMarked = false;
  try {
    await deps.releaseVpsToPool({
      vmId: oldVmId,
      plan: releasedPlan,
      hostingerBillingSubscriptionId: oldBillingId,
      notes: `term-renewal sweep of business ${businessId}; auto-renew off, never_renew`
    });
    pooled = true;
  } catch (err) {
    logger.error("term-renewal sweep: pool return failed", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }
  if (pooled) {
    try {
      await deps.markVpsNeverRenew(oldVmId);
      neverRenewMarked = true;
    } catch (err) {
      logger.error("term-renewal sweep: never_renew mark failed", {
        businessId,
        oldVmId,
        error: errMsg(err)
      });
    }
  }

  if (!pooled || !neverRenewMarked) {
    const detail =
      `cutover done (new srv${newVmId} serving) but old-box bookkeeping failed: ` +
      `pooled=${pooled}, never_renew=${neverRenewMarked}. ` +
      `Mark vps_inventory.never_renew=true for srv${oldVmId} manually before the next adopt.`;
    await notify("failed", detail);
    return { ok: false, detail };
  }

  const followUpParts: string[] = [];
  if (!oldVmStopped) {
    followUpParts.push(`old srv${oldVmId} stop failed (may still be running)`);
  }
  if (
    oldBillingHandling === "auto-renew-disable-FAILED" ||
    oldBillingHandling === "billing-id-unknown-still-renewing"
  ) {
    followUpParts.push(
      `old subscription (${oldBillingId ?? "id unknown"}) may still be renewing`
    );
  }
  const followUp = followUpParts.length > 0 ? ` FOLLOW-UP: ${followUpParts.join("; ")}.` : "";

  const detail =
    `New box: srv${newVmId} (${newVmIp}). Old srv${oldVmId}: ` +
    `stopped=${oldVmStopped}, billing=${oldBillingHandling}, pooled with never_renew.${followUp} ` +
    `Backup: ${backupPath}.`;
  await notify("completed", detail);

  /* c8 ignore next -- production ledger default; tests inject */
  const markOutcome = deps.markProvisioningJobOutcome ?? markProvisioningJobOutcome;
  await markOutcome(businessId, "succeeded").catch((err: unknown) => {
    logger.warn("term-renewal sweep: markProvisioningJobOutcome(succeeded) failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  });

  logger.info("term-renewal sweep: migration complete", {
    businessId,
    vpsSize,
    oldVmId,
    newVmId,
    savingsRatio: input.savingsRatio,
    oldBillingHandling,
    oldVmStopped,
    neverRenewMarked
  });

  return { ok: true, detail };
}
