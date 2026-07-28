/**
 * Purchase-orphan reconciliation for the Hostinger fleet.
 *
 * Hostinger's purchase endpoint can fail-but-charge: it returns an error
 * (observed Jul 5 + Jul 8 2026: a 422 on hostname and a 402 "Card payment
 * could not be completed"; Jul 28 2026 Amy Laidlaw: 402 again while the VM
 * materialized ~58s later) while STILL creating the VM and an active billing
 * subscription. Because `acquireVps` only records pool bookkeeping when the
 * purchase call RETURNS, such a box becomes an invisible orphan: paid for,
 * sitting in `initial`, and unknown to `vps_inventory` — so the next
 * provisioning attempt buys ANOTHER box (double spend).
 *
 * This module closes that gap. On a purchase failure the orchestrator calls
 * {@link reconcileOrphanedPurchases} (with retries via
 * {@link reconcileUntilSizeMatch}), which lists the account's VMs and pools
 * (state=available) every box that:
 *
 *   - was created recently (default: within the last 30 minutes — old strays
 *     like retired experiments must never get auto-pooled), AND
 *   - carries the fail-but-charge signature: Hostinger `state === "initial"`
 *     with NO template applied. When the purchase call fails, the embedded
 *     setup payload is never applied, so the box sits in `initial` with
 *     `template: null` (observed on VMs 1806114 and 1815606). A healthy
 *     concurrent purchase's box has its template from the setup payload and
 *     moves to installing/running — and a `running` tenant box whose
 *     post-purchase pool bookkeeping failed (bookkeeping is best-effort)
 *     must NEVER be pooled out from under its business, AND
 *   - has a recognizable KVM plan (kvm1/kvm2/kvm4/kvm8), AND
 *   - is not already tracked in `vps_inventory` (any state — a `retired` row
 *     means the box was deliberately pulled and must stay out).
 *
 * The caller can then re-run the adopt-first claim (or, for term purchases
 * with `skipPoolAdopt`, adopt the SPECIFIC reconciled orphan) so the paid
 * box is used instead of purchasing again — turning the fail-but-charge trap
 * into a self-healing path.
 *
 * Everything is dependency-injected so tests run without Hostinger or a
 * database; production wiring lives in the orchestrator.
 */

import { logger } from "@/lib/logger";
import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { releaseVpsToPool } from "@/lib/db/vps-inventory";
import type { VpsSize } from "@/lib/vps/size";

/** A box that was found orphaned upstream and returned to the adopt pool. */
export type ReconciledOrphan = {
  vmId: number;
  plan: VpsSize;
  /** Hostinger billing subscription id when known (VM detail or list lookup). */
  hostingerBillingSubscriptionId?: string | null;
};

const KNOWN_PLANS: ReadonlySet<string> = new Set(["kvm1", "kvm2", "kvm4", "kvm8"]);

/** Default recency window for "this orphan belongs to the failing purchase". */
export const ORPHAN_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * How long / how often {@link reconcileUntilSizeMatch} re-scans after a
 * purchase failure. Hostinger has been observed to materialize the VM ~58s
 * after returning 402 (Amy Laidlaw, Jul 28 2026); a 5-minute budget with
 * 30s polls covers that race without hanging a signup forever.
 */
export const ORPHAN_RECONCILE_RETRY_INTERVAL_MS = 30_000;
export const ORPHAN_RECONCILE_RETRY_BUDGET_MS = 5 * 60_000;

/**
 * Normalize Hostinger's human plan label ("KVM 2") to our VpsSize slug
 * ("kvm2"). Returns null for unrecognized plans so callers skip them —
 * pooling a box we can't size-match would poison the adopt-first claim.
 */
export function normalizeHostingerPlan(plan: string | undefined | null): VpsSize | null {
  if (!plan) return null;
  const slug = plan.toLowerCase().replace(/[^a-z0-9]/g, "");
  return KNOWN_PLANS.has(slug) ? (slug as VpsSize) : null;
}

/**
 * Resolve the Hostinger billing subscription id for a VM: prefer the VM
 * detail's `subscription_id`, then fall back to a billing-list lookup by
 * `resource_id` (legacy list shape; live list often omits it, Jul 2026).
 */
export function resolveOrphanBillingSubscriptionId(
  vm: Pick<VirtualMachine, "id" | "subscription_id">,
  billingSubs: Array<Pick<BillingSubscription, "id" | "resource_id">> | null | undefined
): string | null {
  if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
    return vm.subscription_id;
  }
  if (!billingSubs || billingSubs.length === 0) return null;
  const match = billingSubs.find((s) => s.resource_id === String(vm.id));
  return match?.id ?? null;
}

export async function reconcileOrphanedPurchases(args: {
  /** Business whose purchase just failed (audit trail only). */
  businessId: string;
  /** `HostingerClient.listVirtualMachines` (or a stub). */
  listVirtualMachines: () => Promise<VirtualMachine[]>;
  /** `listVpsInventory` (or a stub). */
  listInventory: () => Promise<Pick<VpsInventoryRow, "vm_id">[]>;
  /** `releaseVpsToPool` (or a stub). */
  release: typeof releaseVpsToPool;
  /**
   * Optional billing-list lookup used when a VM lacks `subscription_id`, so
   * the pooled row still carries its Hostinger billing linkage.
   */
  listBillingSubscriptions?: () => Promise<
    Array<Pick<BillingSubscription, "id" | "resource_id">>
  >;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Recency window; defaults to {@link ORPHAN_MAX_AGE_MS}. */
  maxAgeMs?: number;
}): Promise<ReconciledOrphan[]> {
  const nowMs = args.now?.() ?? Date.now();
  const maxAgeMs = args.maxAgeMs ?? ORPHAN_MAX_AGE_MS;

  const [vms, inventory] = await Promise.all([args.listVirtualMachines(), args.listInventory()]);
  const knownVmIds = new Set(inventory.map((row) => row.vm_id));

  let billingSubs: Array<Pick<BillingSubscription, "id" | "resource_id">> | null = null;
  const needBillingLookup = vms.some(
    (vm) =>
      !knownVmIds.has(vm.id) &&
      vm.state === "initial" &&
      !vm.template &&
      !(typeof vm.subscription_id === "string" && vm.subscription_id.length > 0)
  );
  if (needBillingLookup && args.listBillingSubscriptions) {
    try {
      billingSubs = await args.listBillingSubscriptions();
    } catch (err) {
      logger.warn("orphan reconcile: billing-list lookup failed (continuing without linkage)", {
        businessId: args.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const reconciled: ReconciledOrphan[] = [];
  for (const vm of vms) {
    if (knownVmIds.has(vm.id)) continue;
    // Fail-but-charge signature gate (see module header): only a box that
    // was never set up — `initial` with no template — is safe to pool. A
    // running/installing box may belong to a live tenant or a concurrent
    // in-flight provision; stealing it into the pool would let another
    // signup recreate it.
    if (vm.state !== "initial" || vm.template) continue;
    const createdAtMs = vm.created_at ? Date.parse(vm.created_at) : NaN;
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > maxAgeMs) continue;
    const plan = normalizeHostingerPlan(vm.plan);
    if (!plan) continue;

    const hostingerBillingSubscriptionId = resolveOrphanBillingSubscriptionId(vm, billingSubs);

    // Pool it. `releaseVpsToPool` inserts when no row exists and refuses to
    // resurrect retired rows (we already skip known ids above, so this is
    // belt-and-braces against a concurrent writer).
    await args.release({
      vmId: vm.id,
      plan,
      hostname: vm.hostname ?? null,
      hostingerBillingSubscriptionId,
      notes:
        `orphaned purchase reconciled for ${args.businessId}: Hostinger purchase API ` +
        `failed after creating the VM (fail-but-charge). Pooled for adopt-first reuse.`
    });
    logger.warn("Pooled orphaned Hostinger VM after failed purchase", {
      businessId: args.businessId,
      virtualMachineId: vm.id,
      plan,
      hostingerBillingSubscriptionId,
      createdAt: vm.created_at
    });
    reconciled.push({ vmId: vm.id, plan, hostingerBillingSubscriptionId });
  }
  return reconciled;
}

/**
 * Re-scan for fail-but-charge orphans until a size-matching box appears or
 * the budget elapses. Hostinger can return 402 from the purchase endpoint
 * and only materialize the VM ~a minute later; a single immediate scan
 * (Amy Laidlaw Jul 28 2026) missed the paid box and aborted the plan change.
 *
 * Already-pooled orphans from earlier passes stay in the returned list
 * (deduped by vmId) even though later inventory reads will skip them.
 */
export async function reconcileUntilSizeMatch(args: {
  reconcile: () => Promise<ReconciledOrphan[]>;
  vpsSize: VpsSize;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  budgetMs?: number;
}): Promise<ReconciledOrphan[]> {
  const nowFn = args.now ?? Date.now;
  const intervalMs = args.intervalMs ?? ORPHAN_RECONCILE_RETRY_INTERVAL_MS;
  const budgetMs = args.budgetMs ?? ORPHAN_RECONCILE_RETRY_BUDGET_MS;
  const deadline = nowFn() + budgetMs;

  const byId = new Map<number, ReconciledOrphan>();
  for (;;) {
    const batch = await args.reconcile();
    for (const orphan of batch) byId.set(orphan.vmId, orphan);
    const pooled = [...byId.values()];
    if (pooled.some((orphan) => orphan.plan === args.vpsSize)) return pooled;
    if (nowFn() >= deadline) return pooled;
    await args.sleep(intervalMs);
  }
}
