/**
 * Repair tenants left half-migrated by a paid plan change.
 *
 * KIN 2026-09-18 (generic shape, not a hardcoded id):
 *   - businesses.hostinger_vps_id still pointed at the old VM
 *   - vps_inventory for that VM was `available` (returned by upgrade_switch)
 *   - no inventory row assigned to the business
 *   - businesses.tier still the old plan
 *   - voice bridge heartbeat stale, inbound calls failing
 *
 * The watchdog (provisioning-retry, every 5 min) calls this once per tick.
 * It copies the live subscription tier onto businesses.tier, reclaims a
 * pooled VM the business still points at (never stealing a row assigned to
 * someone else), starts that VM, and waits for a voice-bridge heartbeat.
 */

import { logger } from "@/lib/logger";
import {
  listOnlineBusinessesWithVpsPointer,
  updateBusinessEntitlementTier,
  type OnlineBusinessVpsPointer
} from "@/lib/db/businesses";
import { getSubscription, type SubscriptionRow } from "@/lib/db/subscriptions";
import {
  claimSpecificAvailableVps,
  countAssignedVpsForBusiness,
  getVpsInventoryByVmId,
  type VpsInventoryRow
} from "@/lib/db/vps-inventory";
import { waitForVoiceBridgeHeartbeat } from "@/lib/provisioning/voice-bridge-cutover";
import {
  HostingerClient,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";

const MAX_ASSIGNMENT_HEALS_PER_TICK = 1;

export type HealPlanChangeAction =
  | "tier_synced"
  | "reclaimed_pooled_vm"
  | "skipped_claimed_by_other"
  | "skipped_no_inventory"
  | "heartbeat_waited";

export type HealPlanChangeResult = {
  scanned: number;
  actions: Array<{ businessId: string; action: HealPlanChangeAction; detail?: string }>;
};

export type HealPlanChangeDeps = {
  listOnline: () => Promise<OnlineBusinessVpsPointer[]>;
  getSubscription: (businessId: string) => Promise<SubscriptionRow | null>;
  updateTier: typeof updateBusinessEntitlementTier;
  countAssigned: (businessId: string) => Promise<number>;
  getInventoryByVmId: (vmId: number) => Promise<VpsInventoryRow | null>;
  claimSpecific: typeof claimSpecificAvailableVps;
  startVirtualMachine: (vmId: number) => Promise<unknown>;
  waitHeartbeat: typeof waitForVoiceBridgeHeartbeat;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* c8 ignore start -- production Hostinger client; tests inject startVirtualMachine. */
function productionStartVm(): HealPlanChangeDeps["startVirtualMachine"] {
  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
  return (vmId: number) => client.startVirtualMachine(vmId);
}
/* c8 ignore stop */

function parseVmId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function healPlanChangeAftereffects(
  deps: Partial<HealPlanChangeDeps> = {}
): Promise<HealPlanChangeResult> {
  const resolved: HealPlanChangeDeps = {
    /* c8 ignore next -- production default; tests inject listOnline */
    listOnline: deps.listOnline ?? listOnlineBusinessesWithVpsPointer,
    /* c8 ignore next -- production default; tests inject getSubscription */
    getSubscription: deps.getSubscription ?? getSubscription,
    /* c8 ignore next -- production default; tests inject updateTier */
    updateTier: deps.updateTier ?? updateBusinessEntitlementTier,
    /* c8 ignore next -- production default; tests inject countAssigned */
    countAssigned: deps.countAssigned ?? countAssignedVpsForBusiness,
    /* c8 ignore next -- production default; tests inject getInventoryByVmId */
    getInventoryByVmId: deps.getInventoryByVmId ?? getVpsInventoryByVmId,
    /* c8 ignore next -- production default; tests inject claimSpecific */
    claimSpecific: deps.claimSpecific ?? claimSpecificAvailableVps,
    /* c8 ignore next -- production Hostinger start */
    startVirtualMachine: deps.startVirtualMachine ?? productionStartVm(),
    /* c8 ignore next -- production default; tests inject waitHeartbeat */
    waitHeartbeat: deps.waitHeartbeat ?? waitForVoiceBridgeHeartbeat
  };
  const actions: HealPlanChangeResult["actions"] = [];

  let candidates: OnlineBusinessVpsPointer[];
  try {
    candidates = await resolved.listOnline();
  } catch (err) {
    logger.error("heal-plan-change: list online businesses failed", {
      error: errorMessage(err)
    });
    return { scanned: 0, actions };
  }

  let assignmentHeals = 0;
  for (const biz of candidates) {
    try {
      try {
        const sub = await resolved.getSubscription(biz.id);
        if (
          sub &&
          sub.status === "active" &&
          (sub.tier === "starter" || sub.tier === "standard" || sub.tier === "enterprise") &&
          sub.tier !== biz.tier
        ) {
          await resolved.updateTier(biz.id, sub.tier);
          actions.push({
            businessId: biz.id,
            action: "tier_synced",
            detail: `${biz.tier} -> ${sub.tier}`
          });
          logger.info("heal-plan-change: synced businesses.tier from live subscription", {
            businessId: biz.id,
            fromTier: biz.tier,
            toTier: sub.tier
          });
        }
      } catch (err) {
        logger.error("heal-plan-change: tier sync failed (continuing to assignment heal)", {
          businessId: biz.id,
          error: errorMessage(err)
        });
      }

      const vmId = parseVmId(biz.hostinger_vps_id);
      if (vmId === null) continue;

      const assignedCount = await resolved.countAssigned(biz.id);
      if (assignedCount > 0) continue;
      if (assignmentHeals >= MAX_ASSIGNMENT_HEALS_PER_TICK) continue;

      const inventory = await resolved.getInventoryByVmId(vmId);
      if (!inventory) {
        actions.push({ businessId: biz.id, action: "skipped_no_inventory", detail: String(vmId) });
        logger.warn("heal-plan-change: business points at a VM with no inventory row", {
          businessId: biz.id,
          vmId
        });
        continue;
      }
      if (inventory.state === "assigned" && inventory.assigned_business_id !== biz.id) {
        actions.push({
          businessId: biz.id,
          action: "skipped_claimed_by_other",
          detail: inventory.assigned_business_id ?? "unknown"
        });
        logger.warn("heal-plan-change: pointed-at VM is assigned to someone else; not stealing", {
          businessId: biz.id,
          vmId,
          assignedBusinessId: inventory.assigned_business_id
        });
        continue;
      }

      const claimed = await resolved.claimSpecific(vmId, biz.id);
      if (!claimed) {
        actions.push({
          businessId: biz.id,
          action: "skipped_claimed_by_other",
          detail: String(vmId)
        });
        logger.warn("heal-plan-change: claimSpecific lost the race", {
          businessId: biz.id,
          vmId
        });
        continue;
      }

      try {
        await resolved.startVirtualMachine(vmId);
      } catch (err) {
        logger.warn("heal-plan-change: startVirtualMachine failed (continuing to heartbeat wait)", {
          businessId: biz.id,
          vmId,
          error: errorMessage(err)
        });
      }

      const heartbeat = await resolved.waitHeartbeat({
        businessId: biz.id,
        vpsId: String(vmId)
      });
      assignmentHeals += 1;
      actions.push({
        businessId: biz.id,
        action: "reclaimed_pooled_vm",
        detail: String(vmId)
      });
      actions.push({
        businessId: biz.id,
        action: "heartbeat_waited",
        detail: heartbeat.healthy ? "healthy" : "stale"
      });
      logger.info("heal-plan-change: reclaimed pooled VM", {
        businessId: biz.id,
        vmId,
        heartbeatHealthy: heartbeat.healthy
      });
    } catch (err) {
      logger.error("heal-plan-change: tenant heal failed", {
        businessId: biz.id,
        error: errorMessage(err)
      });
    }
  }

  return { scanned: candidates.length, actions };
}
