/**
 * Fleet billing-posture check (cron): every Hostinger VM that a live tenant
 * depends on must have billing auto-renew ON, and pooled (available) boxes
 * should not be silently renewing.
 *
 * Why this exists: pooled boxes are parked with auto-renew OFF and the adopt
 * path re-enables it best-effort — if that re-enable fails (or no billing
 * subscription resolves), the only artifact is an error log, and Hostinger
 * deletes the VM out from under the tenant at the paid period's end. The
 * Jul 8 2026 fleet audit found exactly this state in production (srv1800985
 * hosting a live tenant on a non-renewing subscription expiring Aug 2).
 *
 * Direction 1 (tenant safety, AUTO-HEALED): for every business with a LIVE
 * PAYING relationship — non-wiped AND a NewCoworker subscription in
 * `active`/`past_due` that is BACKED BY A STRIPE PAYMENT — resolve the VM's
 * billing subscription; if auto-renew is off, re-enable it right here and
 * report the finding either way. Healing is safe for exactly this
 * population: the tenant is paying, so renewing is always the correct state
 * — and if they cancel later, the cancel/wipe lifecycle disables auto-renew
 * again as part of its plan (verified: `disable_billing_auto_renewal` op).
 * Stripe-LESS live rows (internal pilots, admin-created enterprise
 * accounts) are checked but surfaced REPORT-ONLY — an "active" flag with no
 * payment behind it must never trigger automatic platform spend. Businesses
 * whose subscription is `canceled` (grace window — lifecycle just parked
 * the box on purpose), `pending` (never paid), or missing (smoke/test rows)
 * are deliberately OUT of scope; their boxes surface via the pool direction
 * once released. Boxes flagged `never_renew` in vps_inventory are NEVER
 * healed even for paying tenants — they must lapse at period end by design
 * (sunk-cost hardware whose renewal costs more than the tenant pays), so
 * the check instead emits a migration-needed finding every run until ops
 * moves the tenant to its correct size.
 *
 * Direction 2 (money leak, REPORT-ONLY): pool boxes in state `available`
 * whose subscription is still auto-renewing cost money while serving nobody.
 * Not auto-disabled — an adopt could have claimed the box between our
 * inventory read and the write, and turning renewal off under a
 * just-adopted tenant is the exact failure this module exists to prevent.
 *
 * All dependencies are injected; the internal route wires production
 * implementations.
 */

import { logger } from "@/lib/logger";
import type { BusinessRow } from "@/lib/db/businesses";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";

export type BillingPostureFinding = {
  kind:
    | "tenant_auto_renew_off"
    | "tenant_vm_unreachable"
    | "stripeless_tenant_auto_renew_off"
    | "never_renew_tenant_migration_needed"
    | "pool_box_auto_renew_on";
  vmId: number;
  businessId: string | null;
  businessName: string | null;
  hostingerBillingSubscriptionId: string | null;
  /** Paid-period end, when known — the deadline the finding is racing. */
  expiresAt: string | null;
  /** True when this run already fixed the problem (tenant direction only). */
  autoHealed: boolean;
  detail: string;
};

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
  ) => Promise<{ stripeBacked: Set<string>; stripeless: Set<string> }>;
  listInventory: () => Promise<VpsInventoryRow[]>;
  getVirtualMachine: (vmId: number) => Promise<VirtualMachine>;
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
  enableAutoRenewal: (subscriptionId: string) => Promise<unknown>;
};

function tenantVmId(business: BusinessRow): number | null {
  if (!providerUsesHostingerLifecycle(resolveVpsProvider(business.vps_provider))) return null;
  const vmId = Number.parseInt(business.hostinger_vps_id ?? "", 10);
  return Number.isFinite(vmId) && vmId > 0 ? vmId : null;
}

/** A subscription that will NOT renew: flag says off, or a terminal status. */
function isNotRenewing(sub: BillingSubscription): boolean {
  return sub.is_auto_renewed === false || sub.status === "non_renewing" || sub.status === "cancelled";
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
  // disabled that box's renewal ON PURPOSE — healing it would re-charge the
  // platform for a box whose tenant already left (Bugbot High on this PR).
  // Pending (never paid) and subscription-less (smoke/test) rows are
  // equally out of scope. Stripe-LESS live rows (internal pilots like the
  // Residency Pilot, admin-created enterprise accounts) are checked but
  // NEVER auto-healed — an "active" flag someone typed into the DB is not
  // a payment, and the Jul 9 run proved the failure mode: the pilot's box
  // was deliberately parked non-renewing and the check flipped it back on.
  // The helper uses any-row semantics so a newer pending row can't shadow
  // an older active subscription (second Bugbot High).
  const liveBusinessIds = await deps.listBusinessIdsWithLiveSubscription(
    candidates.map((entry) => entry.business.id)
  );
  const tenants = candidates.filter(
    (entry) =>
      liveBusinessIds.stripeBacked.has(entry.business.id) ||
      liveBusinessIds.stripeless.has(entry.business.id)
  );

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

    // A never_renew box must lapse at its paid period end NO MATTER WHAT —
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
          ? `box is flagged never_renew but subscription ${subId} is still auto-renewing — disable renewal in hPanel, then migrate this tenant to its correct size (debug/migrate-vps-size.ts) before the period ends`
          : "live tenant is on a never_renew box that lapses at its paid period end — migrate the tenant to its correct size (debug/migrate-vps-size.ts) before then"
      });
      logger.warn("vps billing posture: live tenant on a never_renew box — migration needed", {
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
          "No billing subscription resolved for this VM — verify auto-renew in hPanel manually"
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
          "no Stripe payment behind its active subscription (internal/admin-created) — " +
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
        detail += " — auto-renew re-enabled by posture check";
      } catch (err) {
        detail += ` — re-enable FAILED (${err instanceof Error ? err.message : String(err)}); fix in hPanel`;
      }
    } else {
      detail += " — subscription cancelled upstream; box needs manual replacement before period end";
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
  // The inventory is read HERE, after the (potentially minutes-long,
  // sequential-Hostinger-calls) tenant pass, not at function start: a box
  // adopted mid-run flips to `assigned` in vps_inventory, and a fresh read
  // keeps this pass from emailing ops to disable renewal on a VM that now
  // serves a paying tenant (Bugbot Medium: stale snapshot TOCTOU). The
  // remaining millisecond-scale window is acceptable because this
  // direction is report-only — the email asks for a manual hPanel review,
  // it never flips billing itself.
  const inventory = await deps.listInventory();
  const availableBoxes = inventory.filter((row) => row.state === "available");
  for (const row of availableBoxes) {
    const sub = row.hostinger_billing_subscription_id
      ? subsById.get(row.hostinger_billing_subscription_id) ?? null
      : null;
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
        `pooled (available) box is still auto-renewing (${sub.status}) — ` +
        "disable renewal in hPanel unless it is being held for adoption on purpose"
    });
  }

  return {
    checkedTenantVms: tenants.length,
    checkedPoolBoxes: availableBoxes.length,
    findings
  };
}
