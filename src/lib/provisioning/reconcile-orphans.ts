/**
 * Purchase-orphan reconciliation for the Hostinger fleet.
 *
 * Hostinger's purchase endpoint can fail-but-charge: it returns an error
 * (observed Jul 5 + Jul 8 2026: a 422 on hostname and a 402 "Card payment
 * could not be completed") while STILL creating the VM and an active billing
 * subscription. Because `acquireVps` only records pool bookkeeping when the
 * purchase call RETURNS, such a box becomes an invisible orphan: paid for,
 * sitting in `initial`, and unknown to `vps_inventory` — so the next
 * provisioning attempt buys ANOTHER box (double spend).
 *
 * This module closes that gap. On a purchase failure the orchestrator calls
 * {@link reconcileOrphanedPurchases}, which lists the account's VMs and pools
 * (state=available) every box that:
 *
 *   - was created recently (default: within the last 30 minutes — old strays
 *     like retired experiments must never get auto-pooled), AND
 *   - has a recognizable KVM plan (kvm1/kvm2/kvm4/kvm8), AND
 *   - is not already tracked in `vps_inventory` (any state — a `retired` row
 *     means the box was deliberately pulled and must stay out).
 *
 * The caller can then re-run the adopt-first claim so the orphan is used
 * instead of purchasing again — turning the fail-but-charge trap into a
 * self-healing path.
 *
 * Everything is dependency-injected so tests run without Hostinger or a
 * database; production wiring lives in the orchestrator.
 */

import { logger } from "@/lib/logger";
import type { VirtualMachine } from "@/lib/hostinger/client";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { releaseVpsToPool } from "@/lib/db/vps-inventory";
import type { VpsSize } from "@/lib/vps/size";

/** A box that was found orphaned upstream and returned to the adopt pool. */
export type ReconciledOrphan = {
  vmId: number;
  plan: VpsSize;
};

const KNOWN_PLANS: ReadonlySet<string> = new Set(["kvm1", "kvm2", "kvm4", "kvm8"]);

/** Default recency window for "this orphan belongs to the failing purchase". */
export const ORPHAN_MAX_AGE_MS = 30 * 60 * 1000;

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

export async function reconcileOrphanedPurchases(args: {
  /** Business whose purchase just failed (audit trail only). */
  businessId: string;
  /** `HostingerClient.listVirtualMachines` (or a stub). */
  listVirtualMachines: () => Promise<VirtualMachine[]>;
  /** `listVpsInventory` (or a stub). */
  listInventory: () => Promise<Pick<VpsInventoryRow, "vm_id">[]>;
  /** `releaseVpsToPool` (or a stub). */
  release: typeof releaseVpsToPool;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Recency window; defaults to {@link ORPHAN_MAX_AGE_MS}. */
  maxAgeMs?: number;
}): Promise<ReconciledOrphan[]> {
  const nowMs = args.now?.() ?? Date.now();
  const maxAgeMs = args.maxAgeMs ?? ORPHAN_MAX_AGE_MS;

  const [vms, inventory] = await Promise.all([args.listVirtualMachines(), args.listInventory()]);
  const knownVmIds = new Set(inventory.map((row) => row.vm_id));

  const reconciled: ReconciledOrphan[] = [];
  for (const vm of vms) {
    if (knownVmIds.has(vm.id)) continue;
    const createdAtMs = vm.created_at ? Date.parse(vm.created_at) : NaN;
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > maxAgeMs) continue;
    const plan = normalizeHostingerPlan(vm.plan);
    if (!plan) continue;

    // Pool it. `releaseVpsToPool` inserts when no row exists and refuses to
    // resurrect retired rows (we already skip known ids above, so this is
    // belt-and-braces against a concurrent writer).
    await args.release({
      vmId: vm.id,
      plan,
      hostname: vm.hostname ?? null,
      hostingerBillingSubscriptionId:
        typeof vm.subscription_id === "string" ? vm.subscription_id : null,
      notes:
        `orphaned purchase reconciled for ${args.businessId}: Hostinger purchase API ` +
        `failed after creating the VM (fail-but-charge). Pooled for adopt-first reuse.`
    });
    logger.warn("Pooled orphaned Hostinger VM after failed purchase", {
      businessId: args.businessId,
      virtualMachineId: vm.id,
      plan,
      createdAt: vm.created_at
    });
    reconciled.push({ vmId: vm.id, plan });
  }
  return reconciled;
}
