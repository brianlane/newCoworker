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
 * paying relationship — non-wiped AND a NewCoworker subscription in
 * `active`/`past_due` — resolve the VM's billing subscription; if auto-renew
 * is off, re-enable it right here and report the finding either way.
 * Healing is safe for exactly this population: the tenant is paying, so
 * renewing is always the correct state — and if they cancel later, the
 * cancel/wipe lifecycle disables auto-renew again as part of its plan
 * (verified: `disable_billing_auto_renewal` op). Businesses whose
 * subscription is `canceled` (grace window — lifecycle just parked the box
 * on purpose), `pending` (never paid), or missing (smoke/test rows) are
 * deliberately OUT of scope; their boxes surface via the pool direction
 * once released.
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
  kind: "tenant_auto_renew_off" | "tenant_vm_unreachable" | "pool_box_auto_renew_on";
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
   * subscription (the live-tenant gate). Any-row semantics, NOT
   * newest-row-wins: a newer pending row (resubscribe checkout in flight)
   * must not shadow an older active one and exclude a paying tenant.
   */
  listBusinessIdsWithLiveSubscription: (businessIds: string[]) => Promise<Set<string>>;
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
  const [businesses, inventory, subscriptions] = await Promise.all([
    deps.listBusinesses(),
    deps.listInventory(),
    deps.listBillingSubscriptions()
  ]);
  const subsById = new Map(subscriptions.map((sub) => [sub.id, sub]));
  const findings: BillingPostureFinding[] = [];

  // ---- Direction 1: live tenants must renew (auto-heal). ----
  const candidates = businesses
    .map((business) => ({ business, vmId: tenantVmId(business) }))
    .filter(
      (entry): entry is { business: BusinessRow; vmId: number } =>
        entry.vmId !== null && entry.business.status !== "wiped"
    );
  // Live-tenant gate: only a paying relationship justifies re-enabling
  // Hostinger billing. A canceled-in-grace business still points at its VM
  // until the wipe, and the lifecycle just disabled that box's renewal ON
  // PURPOSE — healing it would re-charge the platform for a box whose
  // tenant already left (Bugbot High on this PR). Pending (never paid) and
  // subscription-less (smoke/test) rows are equally out of scope. The
  // helper uses any-row semantics so a newer pending row can't shadow an
  // older active subscription (second Bugbot High).
  const liveBusinessIds = await deps.listBusinessIdsWithLiveSubscription(
    candidates.map((entry) => entry.business.id)
  );
  const tenants = candidates.filter((entry) => liveBusinessIds.has(entry.business.id));

  for (const { business, vmId } of tenants) {
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
