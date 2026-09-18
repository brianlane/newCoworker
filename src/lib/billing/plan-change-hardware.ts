/**
 * Whether a paid plan change should move hardware, and whether a provisioned
 * box is a real replacement that is safe to cut over onto.
 *
 * Brian 2026-09-18: do not release or replace a tenant's box while that
 * box still has paid Hostinger time (`vps_inventory.expires_at` in the
 * future). KIN's kvm2 (vm 1936826) had `expires_at` 2026-09-28 and was
 * still pooled by `upgrade_switch`. Entitlements (`businesses.tier`)
 * still flip immediately. Hardware moves only when that paid-through
 * instant is at or past now, and only then if size changes or a
 * same-tier term alignment needs a newly bought box.
 *
 * Unknown / missing `expires_at` fails toward keep: throwing away
 * prepaid time we cannot prove is gone is the KIN bug.
 */

import {
  resolveDeployedVpsSize,
  resolveVpsSize,
  type VpsSize
} from "@/lib/vps/size";

export type PlanChangeHardwareTier = "starter" | "standard" | "enterprise";

/**
 * True when `vps_inventory.expires_at` is still in the future, or cannot
 * be read. The Hostinger paid-through column is the lapse / period-end
 * signal the pool already uses.
 */
export function boxHasPaidTimeLeft(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (expiresAt == null || expiresAt === "") return true;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return true;
  return ms > nowMs;
}

/**
 * True when this plan change needs a new (or term-realigned) box.
 *
 * A live box with prepaid time is never replaced. Once that time has
 * lapsed (or there is no live box), term alignment migrates, and every
 * other path migrates only when resolved hardware size actually changes.
 * The pin on `businesses.vps_size` wins on both sides.
 */
export function shouldMigrateHardwareForPlanChange(input: {
  oldTier: PlanChangeHardwareTier;
  newTier: PlanChangeHardwareTier;
  vpsSizePin: string | null | undefined;
  termAlignment: boolean;
  expiresAt?: string | null;
  /** False when the tenant has no numeric Hostinger VM to keep. */
  hasLiveBox?: boolean;
  nowMs?: number;
}): boolean {
  if (input.hasLiveBox !== false && boxHasPaidTimeLeft(input.expiresAt, input.nowMs)) {
    return false;
  }
  if (input.termAlignment) return true;
  // Same-tier period switches keep the live box. A null-pin Starter
  // resolves deployed kvm2 vs new kvm1, which is a default flip, not a
  // reason to buy hardware on a billing-period change.
  if (input.oldTier === input.newTier) return false;
  const from = resolveDeployedVpsSize(input.oldTier, input.vpsSizePin ?? null);
  const to = resolveVpsSize(input.newTier, input.vpsSizePin ?? null);
  return from !== to;
}

export function resolvedHardwareForPlanChange(
  oldTier: PlanChangeHardwareTier,
  newTier: PlanChangeHardwareTier,
  vpsSizePin: string | null | undefined
): { fromHardware: VpsSize; toHardware: VpsSize } {
  return {
    fromHardware: resolveDeployedVpsSize(oldTier, vpsSizePin ?? null),
    toHardware: resolveVpsSize(newTier, vpsSizePin ?? null)
  };
}

/**
 * True when `newVpsId` is a different numeric VM than the box we captured
 * before provision. Same-id "success" is the live box being reused, and
 * releasing it orphans the tenant.
 */
export function isReplacementVm(
  oldVmId: number | null,
  newVpsId: string | null | undefined
): boolean {
  if (oldVmId === null || oldVmId <= 0) return false;
  if (typeof newVpsId !== "string" || !/^\d+$/.test(newVpsId)) return false;
  const next = Number.parseInt(newVpsId, 10);
  return Number.isFinite(next) && next > 0 && next !== oldVmId;
}

export function inventoryAssignedToBusiness(
  row:
    | {
        state: string;
        assigned_business_id: string | null;
      }
    | null
    | undefined,
  businessId: string
): boolean {
  return row?.state === "assigned" && row.assigned_business_id === businessId;
}

export type PlanChangeCutoverInput = {
  migrateVps: boolean;
  oldVmId: number | null;
  newVpsId: string | null | undefined;
  deploySucceeded: boolean | undefined;
  inventoryRow:
    | {
        state: string;
        assigned_business_id: string | null;
      }
    | null
    | undefined;
  /** Paid-through of the box we would pool, not the replacement. */
  oldExpiresAt?: string | null;
  businessId: string;
  heartbeatHealthy: boolean;
  nowMs?: number;
};

/**
 * True only when teardown may pool `oldVmId`. Same-id "success" (KIN:
 * 1936826 provisioned, then released) is never a replacement.
 */
export function canReleaseOldVpsForPlanChange(input: {
  oldVmId: number | null;
  newVpsId: string | null | undefined;
  deploySucceeded: boolean | undefined;
  inventoryRow:
    | {
        state: string;
        assigned_business_id: string | null;
      }
    | null
    | undefined;
  oldExpiresAt?: string | null;
  businessId: string;
  heartbeatHealthy: boolean;
  nowMs?: number;
}): boolean {
  if (!input.heartbeatHealthy) return false;
  if (input.deploySucceeded === false) return false;
  if (boxHasPaidTimeLeft(input.oldExpiresAt, input.nowMs)) return false;
  if (!isReplacementVm(input.oldVmId, input.newVpsId)) return false;
  return inventoryAssignedToBusiness(input.inventoryRow, input.businessId);
}

/**
 * Whether the paid plan change may be logged complete, and whether the old
 * box is safe to stop and return to the pool.
 *
 * A stale `businesses.hostinger_vps_id` is not an assignment. The inventory
 * row for the new VM must be `assigned` to this business, and the voice
 * bridge must be heartbeating, before we treat the cutover as done.
 */
export function planChangeCutoverDecision(input: PlanChangeCutoverInput): {
  releaseOldBox: boolean;
  cutoverReady: boolean;
} {
  if (!input.heartbeatHealthy) {
    return { releaseOldBox: false, cutoverReady: false };
  }
  if (!input.migrateVps) {
    // A stale `hostinger_vps_id` is not an assignment. When inventory
    // exists it must be `assigned` to this business (KIN: the row was
    // `available` after upgrade_switch). No inventory row cannot prove
    // the pointer is pooled, so heartbeat is enough.
    if (
      input.inventoryRow &&
      !inventoryAssignedToBusiness(input.inventoryRow, input.businessId)
    ) {
      return { releaseOldBox: false, cutoverReady: false };
    }
    return { releaseOldBox: false, cutoverReady: true };
  }
  if (input.oldVmId === null) {
    const hasNew =
      typeof input.newVpsId === "string" &&
      /^\d+$/.test(input.newVpsId) &&
      Number.parseInt(input.newVpsId, 10) > 0;
    const deployOk = input.deploySucceeded !== false;
    const assigned = inventoryAssignedToBusiness(input.inventoryRow, input.businessId);
    return { releaseOldBox: false, cutoverReady: hasNew && deployOk && assigned };
  }
  const releaseOldBox = canReleaseOldVpsForPlanChange(input);
  return { releaseOldBox, cutoverReady: releaseOldBox };
}
