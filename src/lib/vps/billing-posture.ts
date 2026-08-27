/**
 * Fleet billing-posture check (cron): every Hostinger VM that a live tenant
 * depends on must have billing auto-renew ON, and pooled (available) boxes
 * should not be silently renewing.
 *
 * Why this exists: pooled boxes are parked with auto-renew OFF and the adopt
 * path re-enables it best-effort, if that re-enable fails (or no billing
 * subscription resolves), the only artifact is an error log, and Hostinger
 * deletes the VM out from under the tenant at the paid period's end. The
 * Jul 8 2026 fleet audit found exactly this state in production (srv1800985
 * hosting a live tenant on a non-renewing subscription expiring Aug 2).
 *
 * Direction 1 (tenant safety, AUTO-HEALED): for every business with a LIVE
 * PAYING relationship, non-wiped AND a NewCoworker subscription in
 * `active`/`past_due` that is BACKED BY A STRIPE PAYMENT, resolve the VM's
 * billing subscription; if auto-renew is off, re-enable it right here and
 * report the finding either way. Healing is safe for exactly this
 * population: the tenant is paying, so renewing is always the correct state,
 * and if they cancel later, the cancel/wipe lifecycle disables auto-renew
 * again as part of its plan (verified: `disable_billing_auto_renewal` op).
 * Cancel-at-period-end tenants are OUT of this heal: their Hostinger
 * renewal was already disabled on purpose at cancel time (so Hostinger
 * cannot charge before the Stripe period-end webhook), and healing them
 * would re-open the "future eating" gap. Stripe-LESS live rows (internal
 * pilots, admin-created enterprise accounts) are checked but surfaced
 * REPORT-ONLY, an "active" flag with no payment behind it must never
 * trigger automatic platform spend. Businesses whose subscription is
 * `canceled` (grace window, lifecycle just parked the box on purpose),
 * `pending` (never paid), or missing (smoke/test rows) are deliberately
 * OUT of scope; their boxes surface via the pool direction once released.
 * Boxes flagged `never_renew` in vps_inventory are NEVER healed even for
 * paying tenants, they must lapse at period end by design (sunk-cost
 * hardware whose renewal costs more than the tenant pays), so the check
 * instead emits a migration-needed finding every run until ops moves the
 * tenant to its correct size.
 *
 * Direction 2 (money leak, REPORT-ONLY): pool boxes in state `available`
 * whose subscription is still auto-renewing cost money while serving nobody.
 * Not auto-disabled, an adopt could have claimed the box between our
 * inventory read and the write, and turning renewal off under a
 * just-adopted tenant is the exact failure this module exists to prevent.
 *
 * Direction 2b (stale inventory, REAPED): a pooled box whose paid period has
 * already ended is dead hardware still advertised as `available`, and nothing
 * else in the codebase can ever clean it up. `claimAvailableVps` refuses any
 * candidate under a 72h runway floor, and the only caller of `retireVps` is
 * the adopt path's catch block, so a lapsed row is never claimed, never
 * adopted, never fails, and never retires: the filter that makes these rows
 * harmless is the same filter that makes them permanent. Four rows had been
 * stuck that way since Aug 2026 (vm 1800980, 1800985, 1806114, 1815606),
 * making the admin pool read as five available boxes when exactly one was
 * adoptable, which overstates spare capacity to anyone planning against it.
 * This pass retires such a row in place. The bar is deliberately high (a
 * paid-through in the past AND a VM that is suspended or gone AND a billing
 * subscription that is cancelled or gone) because retiring a row that still
 * has live hardware behind it would hide a reusable box from adopt-first and
 * cost a real purchase. Hostinger SUSPENDS a lapsed box rather than deleting
 * it, so "absent from the account" alone would miss every real case.
 *
 * All dependencies are injected; the internal route wires production
 * implementations.
 */

import { logger } from "@/lib/logger";
import type { BusinessRow } from "@/lib/db/businesses";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { cycleContradictsNextBilling } from "@/lib/vps/box-term";
import {
  billingCycleMonths as hostingerCycleMonths,
  isVpsBillingSubscription
} from "@/lib/admin/cost-sync";
import { isBusinessRunningStatus } from "@/lib/provisioning/progress";

export type BillingPostureFinding = {
  kind:
    | "tenant_auto_renew_off"
    | "tenant_vm_unreachable"
    | "stripeless_tenant_auto_renew_off"
    | "never_renew_tenant_migration_needed"
    | "pool_box_auto_renew_on"
    /**
     * A pooled box whose paid period has ended and whose hardware is gone.
     * Its inventory row was retired by this run so the pool stops counting
     * it as spare capacity.
     */
    | "pool_box_lapsed_retired"
    /** A Hostinger VM the account owns that vps_inventory has never heard of. */
    | "untracked_vm"
    /** A live tenant with no hostinger_vps_id at all. */
    | "online_tenant_no_box"
    /**
     * A subscription whose declared billing cycle cannot explain its next
     * billing date, so its quoted renewal price is stale too and no monthly
     * cost can be derived from it. The cost sync refuses to publish one.
     */
    | "billing_cycle_price_stale";
  /** Null for findings about a tenant rather than a box. */
  vmId: number | null;
  businessId: string | null;
  businessName: string | null;
  hostingerBillingSubscriptionId: string | null;
  /** Paid-period end, when known, the deadline the finding is racing. */
  expiresAt: string | null;
  /** True when this run already fixed the problem (tenant direction only). */
  autoHealed: boolean;
  detail: string;
};

/**
 * Findings that are ADVISORY: report-only, and not an auto-renew or lapse
 * risk. The ops digest frames everything else as "live boxes at risk of
 * lapsing" and closes by telling the operator to flip the hPanel renewal
 * toggle, which for these is both untrue and actively harmful: flipping
 * renewal off on a healthy tenant box is how you cause the outage the digest
 * is warning about.
 *
 * Advisory findings still need a human, they just need a DIFFERENT human
 * action, so they are counted and shown, never hidden.
 */
export const ADVISORY_FINDING_KINDS: ReadonlySet<BillingPostureFinding["kind"]> = new Set([
  "billing_cycle_price_stale"
]);

/** True when a finding is an auto-renew/lapse risk rather than advisory. */
export function isLapseRiskFinding(finding: Pick<BillingPostureFinding, "kind">): boolean {
  return !ADVISORY_FINDING_KINDS.has(finding.kind);
}

export type BillingPostureResult = {
  checkedTenantVms: number;
  checkedPoolBoxes: number;
  findings: BillingPostureFinding[];
};

export type BillingPostureDeps = {
  listBusinesses: () => Promise<BusinessRow[]>;
  /**
   * Which of the candidate businesses have ANY active/past_due NewCoworker
   * subscription (the live-tenant gate), split by Stripe payment linkage.
   * Any-row semantics, NOT newest-row-wins: a newer pending row (resubscribe
   * checkout in flight) must not shadow an older active one and exclude a
   * paying tenant.
   */
  listBusinessIdsWithLiveSubscription: (
    businessIds: string[]
  ) => Promise<{
    stripeBacked: Set<string>;
    stripeless: Set<string>;
    cancelAtPeriodEnd: Set<string>;
  }>;
  listInventory: () => Promise<VpsInventoryRow[]>;
  getVirtualMachine: (vmId: number) => Promise<VirtualMachine>;
  /**
   * Every VM the Hostinger account owns. Used for the untracked-VM check:
   * reconcileOrphanedPurchases only runs inline inside acquireVps, so a paid
   * fail-but-charge box it missed stays invisible and the next provision
   * purchases again.
   */
  listVirtualMachines: () => Promise<VirtualMachine[]>;
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
  enableAutoRenewal: (subscriptionId: string) => Promise<unknown>;
  /**
   * Retire a lapsed pool row, but only while it is still `available`.
   * Resolves false when the row was claimed between this run's inventory
   * read and the write, which is a benign race, not a failure. The
   * lapsed-pool reaper is the only direction in this module that writes to
   * vps_inventory at all.
   */
  retireLapsedPoolVps: (vmId: number, reason: string) => Promise<boolean>;
};

/**
 * A business the platform genuinely owes a working, renewing box.
 *
 * Live means an active or past_due subscription (Stripe-backed or an internal
 * stripeless row) that is NOT cancelling at period end. Everything else is
 * out of scope by design: a business with no subscription row at all is not a
 * tenant (the marketplace review sandboxes are seeded online purely so a
 * reviewer can sign in), and one cancelling at period end has already had its
 * box released on purpose.
 *
 * Shared by both directions so they cannot drift: the auto-heal loop must not
 * spend platform money outside this set, and the boxless report must not
 * escalate outside it either.
 */
export function isLiveTenant(
  liveBusinessIds: {
    stripeBacked: Set<string>;
    stripeless: Set<string>;
    cancelAtPeriodEnd: Set<string>;
  },
  businessId: string
): boolean {
  if (liveBusinessIds.cancelAtPeriodEnd.has(businessId)) return false;
  return liveBusinessIds.stripeBacked.has(businessId) || liveBusinessIds.stripeless.has(businessId);
}

function tenantVmId(business: BusinessRow): number | null {
  if (!providerUsesHostingerLifecycle(resolveVpsProvider(business.vps_provider))) return null;
  const vmId = Number.parseInt(business.hostinger_vps_id ?? "", 10);
  return Number.isFinite(vmId) && vmId > 0 ? vmId : null;
}

/** A subscription that will NOT renew: flag says off, or a terminal status. */
function isNotRenewing(sub: BillingSubscription): boolean {
  return sub.is_auto_renewed === false || sub.status === "non_renewing" || sub.status === "cancelled";
}

/**
 * True when a pooled row describes hardware that is already gone: its paid
 * period ended, its VM is suspended (Hostinger's lapse state) or absent from
 * the account entirely, and its billing subscription is cancelled or absent.
 *
 * Every clause is a veto and every default leans toward leaving the row
 * alone, because a wrong retire is the expensive direction: it hides a
 * reusable box from adopt-first and the next signup buys hardware we already
 * own. In particular an UNKNOWN paid-through is not lapsed. `hasPoolRunway`
 * treats a null expiry as eligible, so adopt-first still claims those rows
 * and the adopt path retires them itself when the box turns out to be
 * missing; that is the one cleanup path that already works, and reaping
 * underneath it would only race it.
 */
function isLapsedPoolBox(
  row: VpsInventoryRow,
  vm: VirtualMachine | null,
  sub: BillingSubscription | null,
  nowMs: number
): boolean {
  if (!row.expires_at) return false;
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs > nowMs) return false;
  // A running or stopped box still has a disk and can be resumed, so it is
  // adoptable hardware however lapsed its billing looks.
  if (vm !== null && vm.state !== "suspended") return false;
  // A subscription still in any non-terminal state means Hostinger has not
  // finished winding the box down, so the paid-through we hold may be stale.
  if (sub !== null && sub.status !== "cancelled") return false;
  return true;
}

export async function checkVpsBillingPosture(
  deps: BillingPostureDeps
): Promise<BillingPostureResult> {
  const [businesses, subscriptions, inventoryForFlags] = await Promise.all([
    deps.listBusinesses(),
    deps.listBillingSubscriptions(),
    // Early inventory read JUST for the never_renew flags (the flag is set
    // by hand, so staleness over the tenant pass is a non-issue). Direction
    // 2 below deliberately re-reads the inventory AFTER the slow tenant
    // pass for its own TOCTOU reasons.
    deps.listInventory()
  ]);
  const subsById = new Map(subscriptions.map((sub) => [sub.id, sub]));
  const neverRenewVmIds = new Set(
    inventoryForFlags.filter((row) => row.never_renew).map((row) => row.vm_id)
  );
  const findings: BillingPostureFinding[] = [];

  // ---- Direction 1: live tenants must renew (auto-heal). ----
  const candidates = businesses
    .map((business) => ({ business, vmId: tenantVmId(business) }))
    .filter(
      (entry): entry is { business: BusinessRow; vmId: number } =>
        entry.vmId !== null && entry.business.status !== "wiped"
    );
  // Live-tenant gate: only a REAL STRIPE PAYMENT justifies auto-spending
  // platform money by re-enabling Hostinger billing. A canceled-in-grace
  // business still points at its VM until the wipe, and the lifecycle just
  // disabled that box's renewal ON PURPOSE, healing it would re-charge the
  // platform for a box whose tenant already left (Bugbot High on this PR).
  // Cancel-at-period-end is the same deliberate disable, just earlier: the
  // cancel planner turns Hostinger renew off so a colliding renewal date
  // cannot charge before Stripe period end. Pending (never paid) and
  // subscription-less (smoke/test) rows are equally out of scope.
  // Stripe-LESS live rows (internal pilots like the Residency Pilot,
  // admin-created enterprise accounts) are checked but NEVER auto-healed,
  // an "active" flag someone typed into the DB is not a payment, and the
  // Jul 9 run proved the failure mode: the pilot's box was deliberately
  // parked non-renewing and the check flipped it back on. The helper uses
  // any-row semantics so a newer pending row can't shadow an older active
  // subscription (second Bugbot High).
  //
  // Queried over every non-wiped business, not just the ones holding a VM:
  // the boxless check at the bottom needs the same answer, and asking only
  // about box-holders is what let it report every business that has no box
  // and never will.
  const liveBusinessIds = await deps.listBusinessIdsWithLiveSubscription(
    businesses.filter((business) => business.status !== "wiped").map((business) => business.id)
  );
  const tenants = candidates.filter((entry) => isLiveTenant(liveBusinessIds, entry.business.id));

  for (const { business, vmId } of tenants) {
    const stripeBacked = liveBusinessIds.stripeBacked.has(business.id);
    let vm: VirtualMachine;
    try {
      vm = await deps.getVirtualMachine(vmId);
    } catch (err) {
      findings.push({
        kind: "tenant_vm_unreachable",
        vmId,
        businessId: business.id,
        businessName: business.name,
        hostingerBillingSubscriptionId: null,
        expiresAt: null,
        autoHealed: false,
        detail: `VM lookup failed: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }
    const sub =
      typeof vm.subscription_id === "string" ? subsById.get(vm.subscription_id) ?? null : null;

    // A never_renew box must lapse at its paid period end NO MATTER WHAT,
    // the sunk-cost hardware (e.g. KVM8 srv1632631 pooled under the kvm2
    // label) costs more to renew than the tenant pays. Auto-heal is
    // therefore WRONG here: instead of re-enabling renewal, nag ops every
    // run to migrate the tenant onto its correct size (adopt-first from the
    // pool, else a fresh purchase) before the deadline. If someone flipped
    // renewal ON manually (or the adopt-time flag read failed open), report
    // that too so it gets flipped back off.
    if (neverRenewVmIds.has(vmId)) {
      const renewing = sub !== null && !isNotRenewing(sub);
      const subId =
        sub?.id ?? (typeof vm.subscription_id === "string" ? vm.subscription_id : null);
      findings.push({
        kind: "never_renew_tenant_migration_needed",
        vmId,
        businessId: business.id,
        businessName: business.name,
        hostingerBillingSubscriptionId: subId,
        expiresAt: sub ? sub.expires_at ?? sub.next_billing_at ?? null : null,
        autoHealed: false,
        detail: renewing
          ? `box is flagged never_renew but subscription ${subId} is still auto-renewing, disable renewal in hPanel, then migrate this tenant to its correct size (debug/migrate-vps-size.ts) before the period ends`
          : "live tenant is on a never_renew box that lapses at its paid period end, migrate the tenant to its correct size (debug/migrate-vps-size.ts) before then"
      });
      logger.warn("vps billing posture: live tenant on a never_renew box, migration needed", {
        businessId: business.id,
        vmId,
        hostingerBillingSubscriptionId: subId,
        renewing
      });
      continue;
    }

    if (!sub) {
      findings.push({
        kind: "tenant_auto_renew_off",
        vmId,
        businessId: business.id,
        businessName: business.name,
        hostingerBillingSubscriptionId: vm.subscription_id ?? null,
        expiresAt: null,
        autoHealed: false,
        detail:
          "No billing subscription resolved for this VM, verify auto-renew in hPanel manually"
      });
      continue;
    }
    if (!isNotRenewing(sub)) continue;

    // Report-only for Stripe-less live rows: nobody is paying, so the check
    // must never spend platform money on their behalf. The ops email
    // surfaces it for a human call (protect the box, or cancel the internal
    // subscription so the row stops looking live).
    if (!stripeBacked) {
      findings.push({
        kind: "stripeless_tenant_auto_renew_off",
        vmId,
        businessId: business.id,
        businessName: business.name,
        hostingerBillingSubscriptionId: sub.id,
        expiresAt: sub.expires_at ?? sub.next_billing_at ?? null,
        autoHealed: false,
        detail:
          `subscription ${sub.id} is ${sub.status} with auto-renew off, but this business has ` +
          "no Stripe payment behind its active subscription (internal/admin-created), " +
          "auto-heal skipped; enable renewal in hPanel if the box must survive, or cancel " +
          "the internal subscription to silence this finding"
      });
      continue;
    }

    // `cancelled` has no renewal to re-enable; everything else we heal.
    let autoHealed = false;
    let detail = `subscription ${sub.id} is ${sub.status} with auto-renew off`;
    if (sub.status !== "cancelled") {
      try {
        await deps.enableAutoRenewal(sub.id);
        autoHealed = true;
        detail += ", auto-renew re-enabled by posture check";
      } catch (err) {
        detail += `, re-enable FAILED (${err instanceof Error ? err.message : String(err)}); fix in hPanel`;
      }
    } else {
      detail += ", subscription cancelled upstream; box needs manual replacement before period end";
    }
    findings.push({
      kind: "tenant_auto_renew_off",
      vmId,
      businessId: business.id,
      businessName: business.name,
      hostingerBillingSubscriptionId: sub.id,
      expiresAt: sub.expires_at ?? sub.next_billing_at ?? null,
      autoHealed,
      detail
    });
    logger.warn("vps billing posture: live tenant box was not set to renew", {
      businessId: business.id,
      vmId,
      hostingerBillingSubscriptionId: sub.id,
      autoHealed
    });
  }

  // ---- Direction 2: available pool boxes should not renew (report-only). ----

  // The Hostinger VM listing is fetched before the inventory read so the
  // reaper below and the untracked-VM check further down share one snapshot
  // instead of paying Hostinger for two. A failure is tolerated (the posture
  // heal above is the reason this cron exists) but disables both consumers:
  // without the listing we cannot tell dead hardware from live, and neither
  // guessing direction is safe.
  let allVms: VirtualMachine[] | null = null;
  try {
    allVms = await deps.listVirtualMachines();
  } catch (err) {
    logger.warn(
      "billing posture: listVirtualMachines failed; skipping the untracked-VM and lapsed-pool checks",
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
  const vmById = new Map((allVms ?? []).map((vm) => [vm.id, vm]));

  // The inventory is read HERE, after the (potentially minutes-long,
  // sequential-Hostinger-calls) tenant pass, not at function start: a box
  // adopted mid-run flips to `assigned` in vps_inventory, and a fresh read
  // keeps this pass from emailing ops to disable renewal on a VM that now
  // serves a paying tenant (Bugbot Medium: stale snapshot TOCTOU). The
  // remaining millisecond-scale window is acceptable because this
  // direction is report-only, the email asks for a manual hPanel review,
  // it never flips billing itself.
  //
  // Reading it AFTER the VM listing above is deliberate for the reaper too:
  // the inventory is what decides whether anyone is using a box, so it must
  // be the fresher of the pair. A box adopted between the two reads comes
  // back `assigned` and every pass below skips it.
  const inventory = await deps.listInventory();
  const availableBoxes = inventory.filter((row) => row.state === "available");
  const nowMs = Date.now();
  for (const row of availableBoxes) {
    const sub = row.hostinger_billing_subscription_id
      ? subsById.get(row.hostinger_billing_subscription_id) ?? null
      : null;
    const vm = vmById.get(row.vm_id) ?? null;

    // Reap BEFORE the auto-renew check. A lapsed box is non-renewing by
    // definition, so the `continue` below would step straight past it and
    // the row would stay `available` forever, which is the exact state this
    // reaper exists to end.
    if (allVms !== null && isLapsedPoolBox(row, vm, sub, nowMs)) {
      const vmState = vm ? `VM state ${vm.state}` : "VM absent from the Hostinger account";
      const subState = sub ? `subscription ${sub.id} is ${sub.status}` : "no billing subscription";
      let retired = false;
      let claimedMidRun = false;
      let detail =
        `pooled box lapsed on ${row.expires_at} (${vmState}, ${subState}), ` +
        "so it can never be adopted again";
      try {
        retired = await deps.retireLapsedPoolVps(
          row.vm_id,
          `lapsed pool box retired by the billing-posture cron: paid through ${row.expires_at}, ${vmState}, ${subState}`
        );
        claimedMidRun = !retired;
        detail +=
          "; its vps_inventory row was retired, so the pool no longer counts it as spare capacity";
      } catch (err) {
        detail +=
          `; retiring its vps_inventory row FAILED (${err instanceof Error ? err.message : String(err)}), ` +
          "so the row still reads available and overstates the pool, retire it by hand";
      }

      // The row stopped being `available` between this run's inventory read
      // and the guarded write, so a provision claimed it and it is no longer
      // ours to retire. Nothing is wrong and nothing needs doing, so this
      // stays out of the digest: an ops email that reports non-problems is
      // one nobody reads on the day it is right.
      if (claimedMidRun) {
        logger.info("vps billing posture: lapsed pool box was claimed mid-run, leaving it alone", {
          vmId: row.vm_id,
          expiresAt: row.expires_at
        });
        continue;
      }

      findings.push({
        kind: "pool_box_lapsed_retired",
        vmId: row.vm_id,
        businessId: null,
        businessName: null,
        hostingerBillingSubscriptionId: sub?.id ?? row.hostinger_billing_subscription_id,
        expiresAt: row.expires_at,
        autoHealed: retired,
        detail
      });
      logger.warn("vps billing posture: lapsed pool box", {
        vmId: row.vm_id,
        expiresAt: row.expires_at,
        retired
      });
      continue;
    }

    if (!sub || isNotRenewing(sub)) continue;
    findings.push({
      kind: "pool_box_auto_renew_on",
      vmId: row.vm_id,
      businessId: null,
      businessName: null,
      hostingerBillingSubscriptionId: sub.id,
      expiresAt: sub.expires_at ?? sub.next_billing_at ?? null,
      autoHealed: false,
      detail:
        `pooled (available) box is still auto-renewing (${sub.status}), ` +
        "disable renewal in hPanel unless it is being held for adoption on purpose"
    });
  }

  // ---- Direction 3: fleet consistency (report only, never auto-healed). ----
  //
  // Neither of these is a billing-posture problem in the strict sense, but this
  // is the one daily pass that already holds the whole picture: every business,
  // every inventory row, and the Hostinger account. Both states are otherwise
  // completely silent.

  // A VM the account owns that vps_inventory has never heard of.
  // reconcileOrphanedPurchases only ever runs inline inside acquireVps, and a
  // single transient Hostinger error aborts that loop, so a paid
  // fail-but-charge box can stay untracked indefinitely while the next
  // provision purchases another one. Report only: auto-pooling on a schedule
  // is exactly the risk reconcile-orphans.ts:148 warns about, since a box
  // belonging to a concurrent in-flight provision would be stolen.
  //
  // Reuses the snapshot taken above; a failed listing leaves it null and this
  // check reports nothing rather than calling every owned box untracked.
  // Membership is tested against the inventory read BEFORE the reaper ran, so
  // a row this run just retired is still "known" and does not resurface here
  // as an untracked VM.
  const knownVmIds = new Set(inventory.map((row) => Number(row.vm_id)));
  const untrackedVms = (allVms ?? []).filter((vm) => !knownVmIds.has(vm.id));
  // A VM can be missing from vps_inventory and STILL be a live tenant's box
  // (inventory drift: the purchase-time record failed while the business row
  // was repointed). Telling ops to retire that box would take a tenant down,
  // so look up the owner before writing the guidance.
  const tenantByVmId = new Map<number, BusinessRow>();
  for (const business of businesses) {
    if (business.status === "wiped") continue;
    const vmId = tenantVmId(business);
    if (vmId !== null) tenantByVmId.set(vmId, business);
  }
  for (const vm of untrackedVms) {
    const owner = tenantByVmId.get(vm.id) ?? null;
    const shape = `${vm.plan ?? "unknown plan"}, state ${vm.state}`;
    findings.push({
      kind: "untracked_vm",
      vmId: vm.id,
      businessId: owner?.id ?? null,
      businessName: owner?.name ?? null,
      hostingerBillingSubscriptionId:
        typeof vm.subscription_id === "string" ? vm.subscription_id : null,
      expiresAt: null,
      autoHealed: false,
      detail: owner
        ? `Hostinger VM ${vm.id} (${shape}) is a LIVE TENANT box but is absent from ` +
          "vps_inventory: record it as assigned. Do NOT pool or retire it"
        : `Hostinger VM ${vm.id} (${shape}) is absent from vps_inventory and no business ` +
          "points at it: reconcile it (adopt into the pool or retire it) so a later provision " +
          "reuses it instead of buying another box"
    });
  }

  // A live tenant with no box at all. #1016 correctly stopped the hardware
  // advisor escalating these, which left the state unmonitored; a failed
  // migration can produce it.
  //
  // LIVE is the load-bearing word, and this loop used to ignore it: it walked
  // every business, so anything online without a box was an ACTION REQUIRED
  // line forever. Two whole classes of business are boxless on purpose and
  // always will be. The marketplace review sandboxes (Zoom, Meta, Google) are
  // seeded status "online" with no subscription at all, purely so a reviewer
  // can sign in and see a dashboard; they have no tenant to serve and no box
  // to lose. A tenant cancelling at period end is winding down, and the
  // cancel planner has already released its box on purpose. Neither is a
  // half-finished migration, which is what this finding is for, and a digest
  // that cries wolf every day is one nobody reads on the day it is right.
  for (const business of businesses) {
    if (!isBusinessRunningStatus(business.status)) continue;
    if (!providerUsesHostingerLifecycle(resolveVpsProvider(business.vps_provider))) continue;
    if (tenantVmId(business) !== null) continue;
    if (!isLiveTenant(liveBusinessIds, business.id)) continue;
    findings.push({
      kind: "online_tenant_no_box",
      vmId: null,
      businessId: business.id,
      businessName: business.name,
      hostingerBillingSubscriptionId: null,
      expiresAt: null,
      autoHealed: false,
      // tenantVmId also rejects non-numeric and non-positive ids, so say which
      // it is rather than always claiming the column is empty.
      detail:
        `business is ${business.status} but has no usable hostinger_vps_id ` +
        `(${business.hostinger_vps_id === null || business.hostinger_vps_id === "" ? "unset" : `unusable value ${JSON.stringify(business.hostinger_vps_id)}`}): ` +
        "it is serving from nowhere. Check for a half-finished migration and " +
        "re-point or re-provision"
    });
  }

  // A subscription whose declared billing cycle cannot explain its next
  // billing date. Hostinger sometimes moves next_billing_at for a term
  // change without updating billing_period OR renewal_price, which makes any
  // derived monthly cost fiction; buildHostingerSnapshot now refuses to
  // publish it as an actual, so the box silently falls back to the SKU
  // estimate. Say so out loud: the amount actually paid is not reachable
  // from the Hostinger API at all (no orders/invoices read endpoint), so
  // only a human can reconcile it against the hPanel invoice.
  //
  // Report-only by construction. There is nothing to heal: the disagreement
  // is upstream, in what Hostinger reports about its own subscription.
  // Reuses the VM listing taken above; when it failed, the finding still
  // fires with no VM/tenant attribution rather than going silent, since the
  // subscription list alone is enough to spot the disagreement.
  const vmBySubscriptionId = new Map(
    (allVms ?? [])
      .filter((vm) => typeof vm.subscription_id === "string" && vm.subscription_id.length > 0)
      .map((vm) => [vm.subscription_id as string, vm])
  );
  const nowDate = new Date(nowMs);
  for (const sub of subscriptions) {
    // Boxes only. The billing list carries the whole Hostinger account, and
    // this finding's text asserts that the COST SYNC dropped a box's monthly
    // price and that margin now shows an SKU estimate. Neither is true of a
    // domain renewal, which buildHostingerSnapshot never put in the snapshot
    // in the first place. Same predicate the snapshot uses, so the two cannot
    // disagree about what counts as a box.
    if (!isVpsBillingSubscription(sub)) continue;
    // Narrow both inputs BEFORE the detector rather than defaulting them
    // after it. The detector already returns false for an unknown cycle or a
    // missing date, so any `?? fallback` downstream would be unreachable
    // code that reads like a real case.
    const months = hostingerCycleMonths(sub.billing_period, sub.billing_period_unit ?? null);
    const nextBillingAt = sub.next_billing_at;
    if (months === null || !nextBillingAt) continue;
    if (!cycleContradictsNextBilling(months, nextBillingAt, nowDate)) continue;
    const vm = vmBySubscriptionId.get(sub.id) ?? null;
    // A pooled box has a VM but no tenant, and its mis-priced burn still
    // shows on the Costs page, so report it with null attribution.
    const owner = vm === null ? null : (tenantByVmId.get(vm.id) ?? null);
    const quoted = sub.renewal_price ?? sub.total_price ?? null;
    findings.push({
      kind: "billing_cycle_price_stale",
      vmId: vm?.id ?? null,
      businessId: owner?.id ?? null,
      businessName: owner?.name ?? null,
      hostingerBillingSubscriptionId: sub.id,
      // Deliberately null. `expiresAt` is rendered as "period ends", the
      // deadline a finding is RACING, and this box has no deadline: the date
      // in question is a RENEWAL, and calling a renewal a period end is the
      // exact confusion box-term.ts exists to prevent. The detail below
      // already states the date, so setting it here would also print the
      // same timestamp twice (the same reason pool_box_lapsed_retired
      // suppresses the suffix).
      expiresAt: null,
      autoHealed: false,
      detail:
        `Hostinger subscription ${sub.id}${vm ? ` (VM ${vm.id})` : ""} reports a ` +
        `${months}-month cycle at ` +
        `${quoted === null ? "an unknown price" : `$${(quoted / 100).toFixed(2)}`}, but its next ` +
        `billing date is ${nextBillingAt}, far beyond one such cycle. The term was ` +
        "almost certainly changed and Hostinger did not update the period or the price. " +
        "The cost sync has dropped this box's derived monthly cost, so it now shows as an " +
        "SKU ESTIMATE rather than a wrong actual. Read the real amount off the hPanel " +
        "invoice to reconcile margin"
    });
  }

  return {
    checkedTenantVms: tenants.length,
    checkedPoolBoxes: availableBoxes.length,
    findings
  };
}
