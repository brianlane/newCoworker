/**
 * Purchase-orphan reconciliation for the Hostinger fleet.
 *
 * Hostinger's purchase endpoint can fail-but-charge: it returns an error
 * (observed Jul 5 + Jul 8 2026: a 422 on hostname and a 402 "Card payment
 * could not be completed"; Jul 28 2026 Amy Laidlaw: 402 again while the VM
 * materialized ~58s later) while STILL creating the VM and an active billing
 * subscription. Because `acquireVps` only records pool bookkeeping when the
 * purchase call RETURNS, such a box becomes an invisible orphan: paid for,
 * sitting in `initial`, and unknown to `vps_inventory`, so the next
 * provisioning attempt buys ANOTHER box (double spend).
 *
 * This module closes that gap. On a purchase failure the orchestrator calls
 * {@link reconcileOrphanedPurchases} (with retries via
 * {@link reconcileUntilSizeMatch}), which lists the account's VMs and pools
 * (state=available) every box that:
 *
 *   - was created recently (default: within the last 30 minutes, old strays
 *     like retired experiments must never get auto-pooled), AND
 *   - carries an orphan signature (see {@link carriesOrphanSignature}):
 *     either never set up (`initial` with no template, the purchase errored
 *     before the embedded setup payload ran) or set up wearing THIS
 *     business's own purchase hostname (the purchase succeeded and we failed
 *     after it). A `running` box belonging to anyone else is never pooled,
 *     because a tenant box whose post-purchase bookkeeping failed must not be
 *     taken out from under its business, AND
 *   - has a recognizable KVM plan (kvm1/kvm2/kvm4/kvm8), AND
 *   - is not already tracked in `vps_inventory` (any state, a `retired` row
 *     means the box was deliberately pulled and must stay out).
 *
 * The caller can then re-run the adopt-first claim (or, for term purchases
 * with `skipPoolAdopt`, adopt the SPECIFIC reconciled orphan) so the paid
 * box is used instead of purchasing again, turning the fail-but-charge trap
 * into a self-healing path.
 *
 * Everything is dependency-injected so tests run without Hostinger or a
 * database; production wiring lives in the orchestrator.
 */

import { logger } from "@/lib/logger";
import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import type { releaseVpsToPool } from "@/lib/db/vps-inventory";
import { defaultPurchaseHostname } from "@/lib/hostinger/provision";
import type { VpsSize } from "@/lib/vps/size";

/** A box that was found orphaned upstream and returned to the adopt pool. */
export type ReconciledOrphan = {
  vmId: number;
  plan: VpsSize;
  /** Hostinger billing subscription id when known (VM detail or list lookup). */
  hostingerBillingSubscriptionId?: string | null;
  /** `Date.parse(vm.created_at)` when Hostinger returned a parseable stamp. */
  createdAtMs?: number;
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
 * How many scans in a row may fail before we stop waiting for the paid box.
 *
 * Three at the 30s interval tolerates ~90s of Hostinger API flakiness, which
 * covers the ~58s materialization delay that motivated this loop, without
 * spending the whole 5-minute budget when the API is genuinely down and the
 * real purchase error is what the operator needs to see.
 */
export const ORPHAN_RECONCILE_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Normalize Hostinger's human plan label ("KVM 2") to our VpsSize slug
 * ("kvm2"). Returns null for unrecognized plans so callers skip them,
 * pooling a box we can't size-match would poison the adopt-first claim.
 */
export function normalizeHostingerPlan(plan: string | undefined | null): VpsSize | null {
  if (!plan) return null;
  const slug = plan.toLowerCase().replace(/[^a-z0-9]/g, "");
  return KNOWN_PLANS.has(slug) ? (slug as VpsSize) : null;
}

/**
 * States a box bought seconds ago can legitimately be in. A `stopped`,
 * `suspended`, `destroyed`, or `error` box wearing our hostname is a leftover
 * from some earlier life, not the box this purchase just paid for, so it goes
 * to the daily sweep's human report rather than into the pool.
 */
const LIVE_PURCHASE_STATES: ReadonlySet<string> = new Set(["initial", "installing", "running"]);

/**
 * True when an untracked VM is safe to pool as this purchase's stranded box.
 *
 * Two signatures qualify, and they cover the two ways Hostinger takes our
 * money without us recording a box.
 *
 * 1. Never set up: `initial` with no template. The purchase call errored
 *    before the embedded setup payload was applied, so the box cannot be
 *    serving anyone (observed on VMs 1806114 and 1815606).
 * 2. Set up under OUR hostname. The purchase SUCCEEDED and Hostinger applied
 *    the setup payload, but we failed afterwards, so the box is running with
 *    a template and signature 1 refuses it. That is what stranded VM 1936826
 *    on 2026-08-28: paid for, correctly built for KIN Integrated Child
 *    Health, and invisible to a reconciler that only knew signature 1.
 *
 * The hostname is the safety property, not a heuristic: it is derived from
 * the business id, so only this business's own purchase asks for it. Combined
 * with the caller's `vps_inventory` check and recency window, a match means
 * the box was bought for this business, minutes ago, and nothing has recorded
 * it. A box already serving a tenant has an inventory row and never reaches
 * here.
 */
function carriesOrphanSignature(
  vm: Pick<VirtualMachine, "state" | "template" | "hostname">,
  ourPurchaseHostname: string
): boolean {
  if (vm.state === "initial" && !vm.template) return true;
  return vm.hostname === ourPurchaseHostname && LIVE_PURCHASE_STATES.has(vm.state);
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
  /**
   * Business whose purchase just failed. Load-bearing, not just audit: its
   * purchase hostname is one of the two orphan signatures.
   */
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
  /**
   * `HostingerClient.disableBillingAutoRenewal` (or a stub). Auto-renew is
   * turned off BEFORE pooling, mirroring the scheduled orphan sweep: a
   * pooled box is documented as lapsing at period end, and the failure mode
   * this closes is an adopt that fails AFTER pooling, retiring the row with
   * the subscription still renewing, which no monitor can see (retired rows
   * are invisible to the pool posture check, the reaper, untracked_vm, and
   * stale_assigned_row alike). On a disable failure the VM is left for the
   * daily sweep rather than pooled still-billing.
   */
  disableAutoRenew?: (billingSubscriptionId: string) => Promise<unknown>;
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
      carriesOrphanSignature(vm, defaultPurchaseHostname(args.businessId)) &&
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

  const ourPurchaseHostname = defaultPurchaseHostname(args.businessId);

  const reconciled: ReconciledOrphan[] = [];
  for (const vm of vms) {
    if (knownVmIds.has(vm.id)) continue;
    if (!carriesOrphanSignature(vm, ourPurchaseHostname)) continue;
    const createdAtMs = vm.created_at ? Date.parse(vm.created_at) : NaN;
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > maxAgeMs) continue;
    const plan = normalizeHostingerPlan(vm.plan);
    if (!plan) continue;

    const hostingerBillingSubscriptionId = resolveOrphanBillingSubscriptionId(vm, billingSubs);

    // Auto-renew off FIRST (same order and reasoning as the orphan sweep):
    // pooling a still-renewing box means a later failed adopt retires it
    // with the subscription alive, invisible to every posture check. When
    // the disable fails, skip pooling; the daily sweep disables and pools
    // it instead, and this attempt falls through to its original error.
    if (hostingerBillingSubscriptionId && args.disableAutoRenew) {
      try {
        await args.disableAutoRenew(hostingerBillingSubscriptionId);
      } catch (err) {
        logger.error("orphan reconcile: auto-renew disable failed; not pooling", {
          businessId: args.businessId,
          virtualMachineId: vm.id,
          billingSubscriptionId: hostingerBillingSubscriptionId,
          error: err instanceof Error ? err.message : String(err)
        });
        continue;
      }
    }

    // Pool it. `releaseVpsToPool` inserts when no row exists and refuses to
    // resurrect retired rows (we already skip known ids above, so this is
    // belt-and-braces against a concurrent writer). `skipIfClaimed` guards
    // the snapshot race: a concurrent reconciler may have pooled this VM
    // after our inventory read, and a signup may already have CLAIMED it;
    // un-assigning that row mid-adopt would double-adopt one physical box.
    const released = await args.release({
      skipIfClaimed: true,
      vmId: vm.id,
      plan,
      hostname: vm.hostname ?? null,
      hostingerBillingSubscriptionId,
      notes:
        `orphaned purchase reconciled for ${args.businessId}: Hostinger purchase ` +
        `created VM ${vm.id} (${vm.hostname ?? "no hostname"}, state ${vm.state}) but the ` +
        `call did not return a usable box. Pooled for adopt-first reuse.`
    });
    if (released !== "pooled") {
      // A concurrent reconciler pooled it and a claim already landed. It is
      // NOT this attempt's adoptable orphan: pushing it would let
      // reconcileUntilSizeMatch call it a size match, stop waiting, and
      // abandon this business's own box when it materializes a pass later.
      logger.warn("orphan reconcile: VM already pooled-and-claimed elsewhere; not counting it", {
        businessId: args.businessId,
        virtualMachineId: vm.id
      });
      continue;
    }
    logger.warn("Pooled orphaned Hostinger VM after failed purchase", {
      businessId: args.businessId,
      virtualMachineId: vm.id,
      plan,
      hostingerBillingSubscriptionId,
      createdAt: vm.created_at
    });
    reconciled.push({
      vmId: vm.id,
      plan,
      hostingerBillingSubscriptionId,
      createdAtMs
    });
  }
  return reconciled;
}

/**
 * True when an orphan is eligible as the size match for this purchase
 * attempt. Without `minCreatedAtMs`, any size match counts. With it, only
 * orphans created at/after that stamp count, so an unrelated recent
 * fail-but-charge of the same size cannot end the wait before THIS
 * purchase's VM materializes.
 */
export function orphanMatchesPurchaseAttempt(
  orphan: ReconciledOrphan,
  vpsSize: VpsSize,
  minCreatedAtMs?: number,
  /**
   * Upper bound on the orphan's created_at. The VM a fail-but-charge
   * creates is stamped during the failed purchase CALL, so anything created
   * after that call returned belongs to a different (possibly concurrent)
   * attempt. Without this ceiling the retry loop turned the 5s backward
   * slack into a forward-unbounded window: a same-size fail-but-charge
   * from ANOTHER business, materializing minutes later, passed the floor
   * and was adopted as this attempt's box.
   */
  maxCreatedAtMs?: number
): boolean {
  if (orphan.plan !== vpsSize) return false;
  if (minCreatedAtMs === undefined && maxCreatedAtMs === undefined) return true;
  if (typeof orphan.createdAtMs !== "number") return false;
  if (minCreatedAtMs !== undefined && orphan.createdAtMs < minCreatedAtMs) return false;
  if (maxCreatedAtMs !== undefined && orphan.createdAtMs > maxCreatedAtMs) return false;
  return true;
}

/**
 * Re-scan for fail-but-charge orphans until a size-matching box appears or
 * the budget elapses. Hostinger can return 402 from the purchase endpoint
 * and only materialize the VM ~a minute later; a single immediate scan
 * (Amy Laidlaw Jul 28 2026) missed the paid box and aborted the plan change.
 *
 * Already-pooled orphans from earlier passes stay in the returned list
 * (deduped by vmId) even though later inventory reads will skip them.
 *
 * Pass `minCreatedAtMs` (typically just before the purchase call, minus a
 * small clock-skew slack) so an unrelated older orphan of the same size
 * does not short-circuit the wait for the box this purchase paid for.
 */
export async function reconcileUntilSizeMatch(args: {
  reconcile: () => Promise<ReconciledOrphan[]>;
  vpsSize: VpsSize;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  budgetMs?: number;
  /** Only count size matches created at/after this epoch ms. */
  minCreatedAtMs?: number;
  /** See {@link orphanMatchesPurchaseAttempt}; bounds attribution forward. */
  maxCreatedAtMs?: number;
  /**
   * Wait for THIS VM specifically, ignoring the size/age heuristics.
   *
   * Set when the failure named the box Hostinger charged for. The heuristics
   * exist to guess which orphan belongs to this attempt; when the id is known
   * there is nothing to guess, and guessing is actively harmful: a concurrent
   * business's same-size fail-but-charge would otherwise end the wait before
   * our own box materializes, and the caller would adopt theirs.
   */
  awaitVmId?: number;
}): Promise<ReconciledOrphan[]> {
  const nowFn = args.now ?? Date.now;
  const intervalMs = args.intervalMs ?? ORPHAN_RECONCILE_RETRY_INTERVAL_MS;
  const budgetMs = args.budgetMs ?? ORPHAN_RECONCILE_RETRY_BUDGET_MS;
  const deadline = nowFn() + budgetMs;

  const byId = new Map<number, ReconciledOrphan>();
  let consecutiveFailures = 0;
  for (;;) {
    // A single scan failure must not end the wait. `reconcile` lists the
    // Hostinger account, and one transient 5xx there used to abort the whole
    // loop: the caller then rethrew the original purchase error and the paid
    // box was abandoned (with the watchdog free to buy another). The box we
    // are polling for typically materializes ~58s in, well inside the budget,
    // so a blip should cost one poll, not the whole wait.
    //
    // Bounded, though: when the API is simply down every scan throws, and
    // spinning to the full budget would delay surfacing the real purchase
    // error by minutes for no chance of success. A few consecutive failures
    // covers the materialization window and then gives up.
    let batch: ReconciledOrphan[] = [];
    try {
      batch = await args.reconcile();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      logger.warn("orphan reconcile scan failed", {
        consecutiveFailures,
        givingUp: consecutiveFailures >= ORPHAN_RECONCILE_MAX_CONSECUTIVE_FAILURES,
        error: err instanceof Error ? err.message : String(err)
      });
      if (consecutiveFailures >= ORPHAN_RECONCILE_MAX_CONSECUTIVE_FAILURES) {
        return [...byId.values()];
      }
    }
    for (const orphan of batch) byId.set(orphan.vmId, orphan);
    const pooled = [...byId.values()];
    const satisfied =
      args.awaitVmId !== undefined
        ? pooled.some((orphan) => orphan.vmId === args.awaitVmId)
        : pooled.some((orphan) =>
            orphanMatchesPurchaseAttempt(
              orphan,
              args.vpsSize,
              args.minCreatedAtMs,
              args.maxCreatedAtMs
            )
          );
    if (satisfied) {
      return pooled;
    }
    if (nowFn() >= deadline) return pooled;
    await args.sleep(intervalMs);
  }
}
