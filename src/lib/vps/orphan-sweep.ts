/**
 * Fleet orphan sweep (cron): find Hostinger VMs the platform has no
 * `vps_inventory` row for, and either pool the safe ones for reuse or report
 * the rest for a human.
 *
 * Why this exists separately from `reconcile-orphans.ts`: that module runs
 * INLINE in `acquireVps` when a purchase throws, and only looks at boxes
 * created in the last 30 minutes. Anything it misses is invisible forever,
 * because nothing else ever asks "is there a box on this account we are
 * paying for and have no record of?". VM 1806114 was bought on 2026-07-05 by
 * a fail-but-charge, went unreconciled, and sat untracked for 26 days: a
 * KVM 1 with real runway that no signup could reuse because the pool did not
 * know it existed. It was found by hand, not by the platform.
 *
 * The safety model is the MIRROR of the inline path. That one is safe because
 * of a recency CEILING (only boxes from the purchase happening right now).
 * A daily sweep needs a FLOOR: only boxes old enough that no in-flight
 * provision could still be about to write their inventory row. Stealing a box
 * out from under a provision that is mid-flight would be strictly worse than
 * the problem being solved.
 *
 * Two outcomes, deliberately split:
 *
 *   * `pooled`: never-set-up boxes (`initial` with no template) that no
 *     business references. These cannot be serving anyone, so they are safe
 *     to pool as `available` for adopt-first reuse. Auto-renew is turned off
 *     so an unadopted box LAPSES at its paid period end rather than billing
 *     forever; `claimAvailableVps` already refuses anything under a 72h
 *     runway floor, so a nearly-expired box is never handed to a new tenant.
 *   * `reported`: anything else untracked (running, installing, referenced
 *     by a business row, unknown plan). Never pooled: a running box may be a
 *     live tenant whose bookkeeping write failed, and pooling it would let
 *     another signup recreate it. A human decides.
 *
 * All dependencies are injected; the internal route wires production
 * implementations.
 */

import { logger } from "@/lib/logger";
import type { BusinessRow } from "@/lib/db/businesses";
import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";
import { paidThroughFromBillingSub } from "@/lib/db/vps-inventory";
import { normalizeHostingerPlan } from "@/lib/provisioning/reconcile-orphans";
import { sharedHardwareForVm } from "@/lib/vps/shared-hardware";
import type { VpsSize } from "@/lib/vps/size";
import type { OpsOrphanSweepInput } from "@/lib/email/templates/ops-orphan-sweep";

/**
 * How old an untracked box must be before the sweep will touch it.
 *
 * The floor has to clear the slowest path that legitimately leaves a box
 * untracked for a while: a provision that has purchased but not yet written
 * its `vps_inventory` row. `acquireVps` records the row immediately after the
 * purchase returns, and the inline reconciler's own retry budget runs 5
 * minutes, so minutes would nearly do. Six hours is deliberately far beyond
 * that. The sweep runs daily and the boxes it is looking for have been
 * stranded for weeks, so there is nothing to gain from being eager and a real
 * tenant box to lose from being wrong.
 */
export const ORPHAN_SWEEP_MIN_AGE_MS = 6 * 60 * 60 * 1000;

export type OrphanSweepFinding = {
  /**
   * `would_pool` is distinct from `reported` on purpose. A dry run's poolable
   * boxes are not awaiting a human, and folding them into `reported` made a
   * clean dry run send an ACTION REQUIRED digest about boxes the live sweep
   * would have handled by itself.
   */
  kind: "pooled" | "would_pool" | "reported";
  vmId: number;
  plan: string | null;
  state: string;
  createdAt: string | null;
  hostingerBillingSubscriptionId: string | null;
  expiresAt: string | null;
  detail: string;
};

export type OrphanSweepResult = {
  /** VMs on the account the sweep looked at. */
  checked: number;
  /** Untracked VMs old enough to consider. */
  orphaned: number;
  pooled: number;
  /** Dry run only: boxes a live run would have pooled. */
  wouldPool: number;
  /** Boxes deliberately left for a human. */
  reported: number;
  findings: OrphanSweepFinding[];
};

export type OrphanSweepOptions = {
  now?: Date;
  minAgeMs?: number;
  /** Find and report, but change nothing. */
  dryRun?: boolean;
};

export type OrphanSweepDeps = {
  listVirtualMachines: () => Promise<VirtualMachine[]>;
  listVpsInventory: () => Promise<Pick<VpsInventoryRow, "vm_id">[]>;
  listBusinesses: () => Promise<BusinessRow[]>;
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
  getVirtualMachine: (vmId: number) => Promise<VirtualMachine>;
  disableBillingAutoRenewal: (billingSubscriptionId: string) => Promise<unknown>;
  releaseVpsToPool: (input: {
    vmId: number;
    plan: VpsSize;
    hostname?: string | null;
    hostingerBillingSubscriptionId?: string | null;
    expiresAt?: string | null;
    notes?: string | null;
  }) => Promise<unknown>;
  sendOpsEmail: (input: Omit<OpsOrphanSweepInput, "siteUrl">) => Promise<void>;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when a box was never set up: Hostinger `initial` with no template
 * applied. Same signature the inline reconciler gates on, and the reason it
 * is safe to pool: the setup payload never ran, so nothing is serving from
 * it. A `running` box is explicitly NOT this, however untracked it looks.
 */
export function isNeverSetUp(vm: Pick<VirtualMachine, "state" | "template">): boolean {
  return vm.state === "initial" && !vm.template;
}

/** True when the box is old enough that no in-flight provision still owns it. */
export function isOldEnoughToSweep(
  createdAt: string | null | undefined,
  nowMs: number,
  minAgeMs = ORPHAN_SWEEP_MIN_AGE_MS
): boolean {
  if (!createdAt) return false;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs >= minAgeMs;
}

/**
 * Why this untracked box may not be pooled, or null when it may be.
 *
 * Ordered cheapest-first, and every arm is a reason a box could be in use or
 * unsafe to recreate. `businessVmIds` is every `businesses.hostinger_vps_id`
 * on the platform: a box a business points at is that tenant's, whatever the
 * inventory table forgot.
 */
export function orphanPoolBlocker(
  vm: Pick<VirtualMachine, "id" | "state" | "template" | "plan">,
  businessVmIds: ReadonlySet<number>
): string | null {
  if (businessVmIds.has(vm.id)) {
    return "a business still points at this VM (businesses.hostinger_vps_id); it is a tenant box whose inventory row is missing, not an orphan";
  }
  // Keyed by VM id, not business id: this registry is being consulted about a
  // box, and sharedHardwareFor() takes a businessId, so using it here would
  // silently never match.
  const shared = sharedHardwareForVm(vm.id);
  if (shared) {
    return `${shared.businessName} runs on shared hardware here (co-tenant would be destroyed by a recreate)`;
  }
  if (!isNeverSetUp(vm)) {
    return `state=${vm.state}, template=${vm.template ? "applied" : "none"}: a box that was set up may be serving someone, so it is reported rather than pooled`;
  }
  if (!normalizeHostingerPlan(vm.plan)) {
    return `unrecognized plan ${vm.plan ?? "?"}: cannot size-match it for adoption`;
  }
  return null;
}

/** Hostinger billing subscription for a VM, when we can resolve one. */
function resolveBillingSub(
  vm: Pick<VirtualMachine, "id" | "subscription_id">,
  subsById: Map<string, BillingSubscription>,
  subsByResource: Map<string, BillingSubscription>
): BillingSubscription | null {
  if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
    const bySubId = subsById.get(vm.subscription_id);
    if (bySubId) return bySubId;
  }
  return subsByResource.get(String(vm.id)) ?? null;
}

export async function runOrphanSweep(
  deps: OrphanSweepDeps,
  options: OrphanSweepOptions = {}
): Promise<OrphanSweepResult> {
  const nowMs = (options.now ?? new Date()).getTime();
  const minAgeMs = options.minAgeMs ?? ORPHAN_SWEEP_MIN_AGE_MS;
  const dryRun = options.dryRun === true;

  const [vms, inventory, businesses, billingSubs] = await Promise.all([
    deps.listVirtualMachines(),
    deps.listVpsInventory(),
    deps.listBusinesses(),
    deps.listBillingSubscriptions()
  ]);

  const trackedVmIds = new Set(inventory.map((row) => row.vm_id));
  const businessVmIds = new Set(
    businesses
      .map((b) => Number.parseInt(String(b.hostinger_vps_id ?? ""), 10))
      .filter((id) => Number.isFinite(id))
  );
  const subsById = new Map(billingSubs.map((s) => [s.id, s]));
  const subsByResource = new Map(
    billingSubs.filter((s) => s.resource_id).map((s) => [String(s.resource_id), s])
  );

  const findings: OrphanSweepFinding[] = [];
  let orphaned = 0;

  for (const listed of vms) {
    if (trackedVmIds.has(listed.id)) continue;
    if (!isOldEnoughToSweep(listed.created_at, nowMs, minAgeMs)) continue;
    orphaned += 1;

    // The list payload omits `subscription_id` on this account, so fetch the
    // detail to resolve billing linkage and to re-read state against a fresher
    // view than the list. A lookup failure must not abort the whole sweep.
    let vm = listed;
    try {
      vm = await deps.getVirtualMachine(listed.id);
    } catch (err) {
      logger.warn("orphan sweep: VM detail lookup failed (using list payload)", {
        vmId: listed.id,
        error: errMsg(err)
      });
    }

    const billingSub = resolveBillingSub(vm, subsById, subsByResource);
    const expiresAt = billingSub ? paidThroughFromBillingSub(billingSub) : null;
    const base = {
      vmId: vm.id,
      plan: vm.plan ?? null,
      state: vm.state,
      createdAt: vm.created_at ?? null,
      hostingerBillingSubscriptionId: billingSub?.id ?? null,
      expiresAt
    };

    const blocker = orphanPoolBlocker(vm, businessVmIds);
    if (blocker) {
      findings.push({ ...base, kind: "reported", detail: blocker });
      logger.warn("orphan sweep: untracked VM needs a human", { ...base, detail: blocker });
      continue;
    }

    const plan = normalizeHostingerPlan(vm.plan);
    /* c8 ignore next -- orphanPoolBlocker already rejected unknown plans */
    if (!plan) continue;

    if (dryRun) {
      findings.push({
        ...base,
        kind: "would_pool",
        detail: `dry run: would pool as available (${plan}) with auto-renew off`
      });
      continue;
    }

    // Auto-renew off FIRST, so the box lapses on its own if nobody adopts it.
    // Doing this before the pool write means a failure here cannot leave a
    // silently-renewing box recorded as pooled-and-lapsing.
    let autoRenew = "no-billing-subscription-id";
    // Holds the id only on failure, so the report below cannot be reached
    // without one (a disable is never attempted without a subscription).
    let disableFailedSubId: string | null = null;
    if (billingSub) {
      if (billingSub.is_auto_renewed === false) {
        autoRenew = "already-off";
      } else {
        try {
          await deps.disableBillingAutoRenewal(billingSub.id);
          autoRenew = "disabled";
        } catch (err) {
          autoRenew = "disable-FAILED";
          disableFailedSubId = billingSub.id;
          logger.error("orphan sweep: auto-renew disable failed", {
            vmId: vm.id,
            billingSubscriptionId: billingSub.id,
            error: errMsg(err)
          });
        }
      }
    }
    if (disableFailedSubId) {
      const detail =
        `could not disable auto-renew on ${disableFailedSubId}; not pooling, because a ` +
        "pooled box is documented as lapsing at period end and this one would keep billing";
      findings.push({ ...base, kind: "reported", detail });
      continue;
    }

    try {
      await deps.releaseVpsToPool({
        vmId: vm.id,
        plan,
        hostname: vm.hostname ?? null,
        hostingerBillingSubscriptionId: billingSub?.id ?? null,
        // Stamp the paid-through now: claimAvailableVps treats a null expiry
        // as "unknown runway" and would hand a nearly-lapsed box to a signup.
        expiresAt,
        notes:
          "found by the fleet orphan sweep: paid for but absent from vps_inventory " +
          "(never set up, no tenant). Auto-renew off, so it lapses at period end unless adopted."
      });
    } catch (err) {
      const detail = `pool write failed: ${errMsg(err)}`;
      findings.push({ ...base, kind: "reported", detail });
      logger.error("orphan sweep: pool write failed", { vmId: vm.id, error: errMsg(err) });
      continue;
    }

    const detail =
      `pooled as available (${plan}), auto-renew ${autoRenew}` +
      `${expiresAt ? `, paid through ${expiresAt}` : ", paid-through unknown"}`;
    findings.push({ ...base, kind: "pooled", detail });
    logger.warn("orphan sweep: pooled an untracked paid box", { ...base, plan, detail });
  }

  const pooled = findings.filter((f) => f.kind === "pooled").length;
  const wouldPool = findings.filter((f) => f.kind === "would_pool").length;
  const reported = findings.filter((f) => f.kind === "reported").length;

  if (findings.length > 0) {
    await deps.sendOpsEmail({ findings, checkedVms: vms.length, dryRun });
  }

  return { checked: vms.length, orphaned, pooled, wouldPool, reported, findings };
}
