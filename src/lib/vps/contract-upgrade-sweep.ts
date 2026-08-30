/**
 * Fleet contract-upgrade sweep (cron).
 *
 * Every signup buys a MONTHLY Hostinger box, whatever the customer's
 * contract, so the platform never holds non-refundable term hardware behind
 * an open 30-day money-back window. This sweep is the other half of that
 * strategy: once a contract tenant's refund exposure has closed, it moves
 * them onto a box whose Hostinger term covers the rest of their contract.
 *
 * Three gates, all of which must hold:
 *
 * 1. **Refund exposure closed.** We will not buy non-refundable term
 *    hardware for a customer who can still ask for their money back. Read
 *    from the refund right itself rather than from the subscription's age,
 *    so a customer who already spent their lifetime-once refund, or who
 *    upgraded to a contract years into a monthly plan, is eligible at once.
 * 2. **Prepaid runway does not cover the contract.** See
 *    `assessContractCoverage`. A tenant who adopted a pooled box with a year
 *    of prepaid time left is already funded for that year and is left alone.
 * 3. **The box is inside its renewal window.** The same 36h window the
 *    term-renewal sweep uses. This is what stops us throwing away prepaid
 *    time: we act as the current box is about to renew or lapse, not the
 *    moment the tenant becomes eligible.
 *
 * Together those three mean a 24-month tenant who adopted a 12-month box is
 * untouched for ~12 months, and is then moved onto a 1y box (the remaining
 * shortfall), not another 2y one.
 *
 * Shares the migration, the candidate guards, and the renewal-window and
 * cooldown rules with `term-renewal-sweep.ts` so there is exactly one
 * definition of "how a tenant is moved between boxes" and of "which tenants
 * may be touched at all". It runs on its OWN cron at a different hour, with
 * its own one-migration-per-run budget, so neither sweep can starve the
 * other.
 */

import { logger } from "@/lib/logger";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { CustomerProfileRow } from "@/lib/db/customer-profiles";
import type { BillingSubscription, CatalogItem, VirtualMachine } from "@/lib/hostinger/client";
import { hostingerTermMonths, type HostingerBillingTerm } from "@/lib/hostinger/provision";
import { paidThroughFromBillingSub } from "@/lib/db/vps-inventory";
import { billingCycleMonths } from "@/lib/admin/cost-sync";
import { resolveDeployedVpsSize, type VpsSize } from "@/lib/vps/size";
import {
  billingSubCentsPerMonth,
  catalogFirstPeriodCentsPerMonth,
  findCatalogPrice,
  monthlySavingsRatio
} from "@/lib/vps/catalog-pricing";
import {
  assessContractCoverage,
  isContractBillingPeriod,
  isRefundExposureOpen
} from "@/lib/vps/contract-coverage";
import {
  DEFAULT_PURCHASE_COOLDOWN_HOURS,
  DEFAULT_RENEWAL_WINDOW_HOURS,
  DEFAULT_SAVINGS_THRESHOLD,
  guardCandidate,
  isPartialTermCutover,
  isWithinPurchaseCooldown,
  isWithinRenewalWindow,
  migrateTenantToFreshBox,
  nextBillingTimestamp,
  resolveBillingSub,
  tenantVmId,
  type TermRenewalSweepDeps
} from "@/lib/vps/term-renewal-sweep";
import { sweepFailureLines } from "@/lib/vps/term-renewal-sweep";

const SWEEP_REQUESTED_BY = "contract-upgrade-sweep";

export type ContractUpgradeSweepFinding = {
  kind:
    | "skipped_refund_window_open"
    | "skipped_covered"
    | "skipped_not_due"
    | "skipped_unknown_renewal"
    | "skipped_economics"
    | "skipped_guard"
    | "skipped_in_flight"
    | "skipped_cooldown"
    | "migrated"
    | "migration_failed";
  businessId: string;
  businessName: string;
  vmId: number;
  detail: string;
  /** Term we intended to buy, when coverage was assessed. */
  term?: HostingerBillingTerm;
  /** Months of contract the current box does not fund. */
  shortfallMonths?: number;
  savingsRatio?: number;
};

export type ContractUpgradeSweepResult = {
  /** Contract tenants examined (past the cheap billing-period filter). */
  checked: number;
  /** Tenants already funded through the end of their contract. */
  alreadyCovered: number;
  migrated: number;
  findings: ContractUpgradeSweepFinding[];
  /** migration_failed lines for the run recorder; see TermRenewalSweepResult.failures. */
  failures: string[];
};

export type ContractUpgradeSweepOptions = {
  savingsThreshold?: number;
  renewalWindowHours?: number;
  purchaseCooldownHours?: number;
  now?: Date;
};

export type ContractUpgradeSweepDeps = TermRenewalSweepDeps & {
  /**
   * Customer profiles for the refund-exposure gate, keyed by PROFILE id.
   * The sweep maps them onto businesses itself through
   * `subscriptions.customer_profile_id`, which it already holds, so this
   * stays the existing batch reader rather than a new joined query.
   */
  listCustomerProfilesByIds: (ids: string[]) => Promise<Map<string, CustomerProfileRow>>;
  /**
   * Most recent contract-upgrade purchase for this business, or null. Keyed
   * on the contract-upgrade purpose specifically: a term-renewal purchase is
   * not evidence that THIS sweep's purchase failed, and cooling down on it
   * would strand a tenant whose box is genuinely about to lapse.
   */
  getLastContractUpgradePurchaseAt: (businessId: string) => Promise<Date | null>;
};

type UpgradeCandidate = {
  business: BusinessRow;
  vmId: number;
  vpsSize: VpsSize;
  subscription: SubscriptionRow;
  billingSub: BillingSubscription;
  nextBillingAt: string;
  boxPaidThrough: string | null;
  term: HostingerBillingTerm;
  shortfallMonths: number;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Months in the box's current Hostinger cycle, used to spread its renewal
 * price into a comparable per-month figure.
 *
 * Read from the subscription's OWN `billing_period` / `billing_period_unit`,
 * which is what Hostinger reports the cycle to be. An earlier version
 * inferred it from `created_at` to `expires_at`, which is wrong for any box
 * past its first cycle: `created_at` is the original PURCHASE date, not the
 * current cycle start, so a monthly box bought seven months ago measured as
 * a seven-month cycle. Its single-month `renewal_price` then divided by
 * seven, understating cents-per-month by 7x and failing the savings gate for
 * exactly the long-standing monthly tenants this sweep exists to move.
 *
 * `billing_period`/`billing_period_unit` are the live API's (Jul 2026)
 * fields; the legacy `period`/`period_unit` pair is kept as a fallback, the
 * same precedence `currentHostingerCycleMonths` uses in the change-plan
 * orchestrator. Unit resolution itself is the shared
 * {@link billingCycleMonths}, so there is one definition of what a Hostinger
 * cycle unit means.
 */
export function billingSubCycleMonths(
  sub: Pick<
    BillingSubscription,
    "billing_period" | "billing_period_unit" | "period" | "period_unit"
  >
): number | null {
  const period = sub.billing_period ?? sub.period;
  const unit = sub.billing_period_unit ?? sub.period_unit;
  if (typeof period !== "number") return null;
  return billingCycleMonths(period, unit ?? null);
}

export async function runContractUpgradeSweep(
  deps: ContractUpgradeSweepDeps,
  options: ContractUpgradeSweepOptions = {}
): Promise<ContractUpgradeSweepResult> {
  const now = options.now ?? new Date();
  // Budget starts with the SWEEP, not with the migration: the fleet scan and
  // per-candidate VM lookups below spend the same route ceiling.
  const sweepStartedAtMs = Date.now();
  const savingsThreshold = options.savingsThreshold ?? DEFAULT_SAVINGS_THRESHOLD;
  const renewalWindowHours = options.renewalWindowHours ?? DEFAULT_RENEWAL_WINDOW_HOURS;
  const purchaseCooldownHours = options.purchaseCooldownHours ?? DEFAULT_PURCHASE_COOLDOWN_HOURS;

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
  // A tenant who scheduled cancellation is leaving at period end. Buying
  // them a term box would spend money on hardware for a contract they have
  // already told us they are not continuing. Mirrors the term-renewal sweep.
  const stripeBacked = hostingerCandidates.filter(
    (entry) =>
      liveIds.stripeBacked.has(entry.business.id) &&
      !liveIds.cancelAtPeriodEnd.has(entry.business.id)
  );

  const subByBusiness = await deps.listSubscriptionsByBusinessIds(
    stripeBacked.map((entry) => entry.business.id)
  );

  // Narrow to CONTRACT tenants before the profile lookup: monthly tenants
  // are the majority and have nothing to cover, so there is no reason to
  // load their refund state.
  const contractTenants = stripeBacked.filter((entry) => {
    const sub = subByBusiness.get(entry.business.id);
    return sub?.status === "active" && isContractBillingPeriod(sub.billing_period);
  });

  // Map business -> profile through the subscription's own link. A
  // subscription with no `customer_profile_id` yields no profile, which
  // `isRefundExposureOpen` treats as "exposure open" and therefore skips:
  // we cannot prove the refund right is spent, so we do not buy
  // non-refundable hardware on a guess.
  const profileIds = [
    ...new Set(
      contractTenants
        .map((entry) => subByBusiness.get(entry.business.id)?.customer_profile_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  ];
  const profilesById = await deps.listCustomerProfilesByIds(profileIds);

  const findings: ContractUpgradeSweepFinding[] = [];
  const candidates: UpgradeCandidate[] = [];
  let alreadyCovered = 0;

  for (const { business, vmId } of contractTenants) {
    // Non-null by construction: contractTenants was filtered on this map.
    const subscription = subByBusiness.get(business.id)!;

    // Gate 1: never put non-refundable hardware behind a refundable
    // subscription. Checked FIRST because it is a pure read and it excludes
    // every brand-new signup without touching Hostinger.
    const profileId = subscription.customer_profile_id;
    const profile = profileId ? (profilesById.get(profileId) ?? null) : null;
    if (isRefundExposureOpen(profile, now)) {
      findings.push({
        kind: "skipped_refund_window_open",
        businessId: business.id,
        businessName: business.name,
        vmId,
        detail: profileId
          ? "30-day money-back exposure is still open; a term box bought now would be " +
            "non-refundable to us if they cancel"
          : "no customer profile on the subscription, so refund eligibility cannot be " +
            "verified; refusing to buy non-refundable term hardware"
      });
      continue;
    }

    let vm: VirtualMachine;
    try {
      vm = await deps.hostinger.getVirtualMachine(vmId);
    } catch (err) {
      logger.warn("contract-upgrade sweep: VM lookup failed", {
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
        detail:
          "partial cutover detected: businesses.hostinger_vps_id billing id differs from " +
          "subscriptions.hostinger_billing_subscription_id; manual recovery required before retry"
      });
      continue;
    }

    const billingSub = resolveBillingSub(subscription, vm, subsById);
    if (!billingSub) continue;
    const boxPaidThrough = paidThroughFromBillingSub(billingSub);

    // Gate 2: is this box already funding the contract?
    const coverage = assessContractCoverage({ subscription, boxPaidThrough, now });
    if (coverage.covered) {
      alreadyCovered += 1;
      findings.push({
        kind: "skipped_covered",
        businessId: business.id,
        businessName: business.name,
        vmId,
        detail:
          coverage.reason === "runway_covers_contract"
            ? // Only returned for a parseable paid-through, so this is never null.
              `box is paid through ${boxPaidThrough}, which covers the contract`
            : "contract has no readable Stripe period end, so there is nothing to cover"
      });
      continue;
    }

    // Gate 3: act as the box is about to renew or lapse, not the moment the
    // tenant becomes eligible, so prepaid time is never thrown away.
    const nextBillingAt = nextBillingTimestamp(billingSub);
    if (!nextBillingAt) {
      // Surfaced rather than silently skipped: a box we can never time is a
      // tenant who would sit on short-runway hardware forever.
      findings.push({
        kind: "skipped_unknown_renewal",
        businessId: business.id,
        businessName: business.name,
        vmId,
        term: coverage.term,
        shortfallMonths: coverage.shortfallMonths,
        detail:
          "Hostinger reports no next_billing_at/expires_at for this box, so the upgrade " +
          "cannot be timed to its renewal. Needs a manual look."
      });
      continue;
    }
    if (!isWithinRenewalWindow(nextBillingAt, now, renewalWindowHours)) {
      findings.push({
        kind: "skipped_not_due",
        businessId: business.id,
        businessName: business.name,
        vmId,
        term: coverage.term,
        shortfallMonths: coverage.shortfallMonths,
        detail:
          `box renews ${nextBillingAt}, outside the ${renewalWindowHours}h window; ` +
          `${coverage.shortfallMonths} contract months still to fund, will upgrade at renewal`
      });
      continue;
    }

    candidates.push({
      business,
      vmId,
      vpsSize: resolveDeployedVpsSize(business.tier, business.vps_size),
      subscription,
      billingSub,
      nextBillingAt,
      boxPaidThrough,
      term: coverage.term,
      shortfallMonths: coverage.shortfallMonths
    });
  }

  // Soonest renewal first: that tenant has the least runway left.
  candidates.sort(
    (a, b) => new Date(a.nextBillingAt).getTime() - new Date(b.nextBillingAt).getTime()
  );

  let migrated = 0;

  for (const candidate of candidates) {
    const { business, vmId, vpsSize, subscription, billingSub, nextBillingAt, term } = candidate;

    if (await deps.hasActiveVpsMigrationLock(business.id)) {
      findings.push({
        kind: "skipped_in_flight",
        businessId: business.id,
        businessName: business.name,
        vmId,
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
        detail: guard
      });
      continue;
    }

    // Still eligible AND we bought them a term box recently means the
    // earlier purchase never finished cutover: the tenant is on the old box,
    // the paid new one is stranded, and buying again strands another.
    const lastPurchaseAt = await deps.getLastContractUpgradePurchaseAt(business.id);
    if (lastPurchaseAt && isWithinPurchaseCooldown(lastPurchaseAt, now, purchaseCooldownHours)) {
      findings.push({
        kind: "skipped_cooldown",
        businessId: business.id,
        businessName: business.name,
        vmId,
        detail:
          `a contract-upgrade box was bought at ${lastPurchaseAt.toISOString()}, inside the ` +
          `${purchaseCooldownHours}h cooldown, and they are still eligible: that purchase did ` +
          "not finish cutover. Not buying another; finish or unwind that box first"
      });
      continue;
    }

    // Economics, in cents PER MONTH. Comparing whole periods here would read
    // a 2-year first period against a one-month renewal and skip every
    // upgrade as uneconomic while the sweep reported itself healthy.
    const currentCentsPerMonth = billingSubCentsPerMonth(
      billingSub,
      billingSubCycleMonths(billingSub)
    );
    const targetPrice = findCatalogPrice(catalog, vpsSize, term);
    const targetCentsPerMonth = targetPrice
      ? catalogFirstPeriodCentsPerMonth(targetPrice)
      : null;
    if (currentCentsPerMonth === null || targetCentsPerMonth === null) {
      findings.push({
        kind: "skipped_economics",
        businessId: business.id,
        businessName: business.name,
        vmId,
        term,
        detail:
          `cannot compare per-month cost (current=${currentCentsPerMonth ?? "unknown"}, ` +
          `${vpsSize}@${term}=${targetCentsPerMonth ?? "unknown"}); ` +
          "SKU may have been renamed, re-verify with debug/hostinger-term-prices.ts"
      });
      continue;
    }
    const savingsRatio = monthlySavingsRatio(currentCentsPerMonth, targetCentsPerMonth);
    if (savingsRatio < savingsThreshold) {
      findings.push({
        kind: "skipped_economics",
        businessId: business.id,
        businessName: business.name,
        vmId,
        term,
        savingsRatio,
        detail:
          `current $${(currentCentsPerMonth / 100).toFixed(2)}/mo vs ${term} first-period ` +
          `$${(targetCentsPerMonth / 100).toFixed(2)}/mo saves ` +
          `${(savingsRatio * 100).toFixed(1)}% (need ${(savingsThreshold * 100).toFixed(0)}%)`
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
        detail: "could not claim migration lease (another migration may have started)"
      });
      continue;
    }

    try {
      const outcome = await migrateTenantToFreshBox(
        {
          businessId: business.id,
          vpsSize,
          economicsDetail:
            `Contract upgrade: ${candidate.shortfallMonths} month(s) of the ` +
            `${subscription.billing_period} contract are unfunded (box paid through ` +
            // Non-null past the nextBillingAt gate: both it and the
            // paid-through derive from the same two Hostinger fields.
            `${candidate.boxPaidThrough}). Buying ${term} ` +
            `(${hostingerTermMonths(term)} months) at ` +
            `$${(targetCentsPerMonth / 100).toFixed(2)}/mo vs current ` +
            `$${(currentCentsPerMonth / 100).toFixed(2)}/mo ` +
            `(${(savingsRatio * 100).toFixed(1)}% savings). Box renews ${nextBillingAt}.`,
          purpose: "contract_upgrade",
          requestedBy: SWEEP_REQUESTED_BY,
          hostingerTerm: term,
          paidThroughAt: paidThroughFromBillingSub(billingSub),
          budgetStartedAtMs: sweepStartedAtMs
        },
        deps
      );
      findings.push({
        kind: outcome.ok ? "migrated" : "migration_failed",
        businessId: business.id,
        businessName: business.name,
        vmId,
        term,
        shortfallMonths: candidate.shortfallMonths,
        savingsRatio,
        detail: outcome.detail
      });
      if (outcome.ok) migrated = 1;
    } finally {
      try {
        await deps.releaseVpsMigrationLock(business.id);
      } catch (releaseErr) {
        logger.warn("contract-upgrade sweep: migration lock release failed", {
          businessId: business.id,
          error: errMsg(releaseErr)
        });
      }
    }
    // One migration per run, same budget discipline as the renewal sweep.
    break;
  }

  return {
    checked: contractTenants.length,
    alreadyCovered,
    migrated,
    findings,
    failures: sweepFailureLines(findings)
  };
}
