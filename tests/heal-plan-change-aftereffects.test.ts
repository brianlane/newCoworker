import { describe, expect, it, vi } from "vitest";

import { healPlanChangeAftereffects } from "@/lib/billing/heal-plan-change-aftereffects";
import type { VpsInventoryRow } from "@/lib/db/vps-inventory";

function assignedRow(vmId: number, businessId: string): VpsInventoryRow {
  return {
    vm_id: vmId,
    plan: "kvm2",
    state: "assigned",
    assigned_business_id: businessId,
    assigned_at: "2026-09-18T00:00:00.000Z",
    hostname: `srv${vmId}.hstgr.cloud`,
    hostinger_billing_subscription_id: null,
    expires_at: null,
    notes: null,
    never_renew: false,
    acquired_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z"
  };
}

function pooledRow(vmId: number): VpsInventoryRow {
  return {
    ...assignedRow(vmId, "nobody"),
    state: "available",
    assigned_business_id: null,
    notes: "returned by upgrade_switch"
  };
}

describe("healPlanChangeAftereffects", () => {
  it("syncs businesses.tier from the live subscription both directions", async () => {
    const updateTier = vi.fn().mockResolvedValue({ tier: "starter" });
    const result = await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-down", tier: "standard", hostinger_vps_id: "1" },
        { id: "biz-up", tier: "starter", hostinger_vps_id: "2" }
      ],
      getSubscription: async (id) =>
        id === "biz-down"
          ? ({ status: "active", tier: "starter" } as never)
          : ({ status: "active", tier: "standard" } as never),
      updateTier,
      countAssigned: async () => 1,
      getInventoryByVmId: async () => assignedRow(1, "biz-down"),
      claimSpecific: vi.fn(),
      startVirtualMachine: vi.fn(),
      waitHeartbeat: vi.fn()
    });
    expect(updateTier).toHaveBeenCalledWith("biz-down", "starter");
    expect(updateTier).toHaveBeenCalledWith("biz-up", "standard");
    expect(result.actions.map((a) => a.action)).toEqual(["tier_synced", "tier_synced"]);
  });

  it("reclaims a pooled VM the business still points at, starts it, and waits for heartbeat (KIN shape)", async () => {
    const claimSpecific = vi.fn().mockResolvedValue(assignedRow(1936826, "biz-kin"));
    const startVirtualMachine = vi.fn().mockResolvedValue({ id: 1 });
    const waitHeartbeat = vi.fn().mockResolvedValue({
      healthy: true,
      heartbeatAt: "2026-09-18T16:00:00.000Z",
      restarted: true
    });
    const result = await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-kin", tier: "standard", hostinger_vps_id: "1936826" }
      ],
      getSubscription: async () => ({ status: "active", tier: "starter" } as never),
      updateTier: vi.fn().mockResolvedValue({ tier: "starter" }),
      countAssigned: async () => 0,
      getInventoryByVmId: async () => pooledRow(1936826),
      claimSpecific,
      startVirtualMachine,
      waitHeartbeat
    });
    expect(claimSpecific).toHaveBeenCalledWith(1936826, "biz-kin");
    expect(startVirtualMachine).toHaveBeenCalledWith(1936826);
    expect(waitHeartbeat).toHaveBeenCalledWith({
      businessId: "biz-kin",
      vpsId: "1936826"
    });
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "tier_synced" }),
        expect.objectContaining({ action: "reclaimed_pooled_vm", detail: "1936826" }),
        expect.objectContaining({ action: "heartbeat_waited", detail: "healthy" })
      ])
    );
  });

  it("does not steal a VM assigned to another tenant", async () => {
    const claimSpecific = vi.fn();
    const result = await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-kin", tier: "starter", hostinger_vps_id: "1936826" },
        { id: "biz-orphan", tier: "starter", hostinger_vps_id: "9" }
      ],
      getSubscription: async () => ({ status: "active", tier: "starter" } as never),
      updateTier: vi.fn(),
      countAssigned: async () => 0,
      getInventoryByVmId: async (vmId) =>
        vmId === 9
          ? { ...assignedRow(9, "nobody"), assigned_business_id: null }
          : assignedRow(1936826, "someone-else"),
      claimSpecific,
      startVirtualMachine: vi.fn(),
      waitHeartbeat: vi.fn()
    });
    expect(claimSpecific).not.toHaveBeenCalled();
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "skipped_claimed_by_other", detail: "someone-else" }),
        expect.objectContaining({ action: "skipped_claimed_by_other", detail: "unknown" })
      ])
    );
  });

  it("skips a pointer with no inventory row and a non-numeric hostinger_vps_id", async () => {
    const result = await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-missing", tier: "starter", hostinger_vps_id: "1936826" },
        { id: "biz-bad-id", tier: "starter", hostinger_vps_id: "pending" },
        { id: "biz-zero", tier: "starter", hostinger_vps_id: "0" },
        { id: "biz-huge", tier: "starter", hostinger_vps_id: "9".repeat(400) }
      ],
      getSubscription: async () => ({ status: "active", tier: "starter" } as never),
      updateTier: vi.fn(),
      countAssigned: async () => 0,
      getInventoryByVmId: async () => null,
      claimSpecific: vi.fn(),
      startVirtualMachine: vi.fn(),
      waitHeartbeat: vi.fn()
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ action: "skipped_no_inventory" })
    ]);
  });

  it("records a lost claim race and continues when startVirtualMachine throws", async () => {
    const waitHeartbeat = vi.fn().mockResolvedValue({
      healthy: false,
      heartbeatAt: null,
      restarted: false
    });
    const lost = await healPlanChangeAftereffects({
      listOnline: async () => [{ id: "biz-1", tier: "starter", hostinger_vps_id: "9" }],
      getSubscription: async () => ({ status: "active", tier: "starter" } as never),
      updateTier: vi.fn(),
      countAssigned: async () => 0,
      getInventoryByVmId: async () => pooledRow(9),
      claimSpecific: vi.fn().mockResolvedValue(null),
      startVirtualMachine: vi.fn(),
      waitHeartbeat
    });
    expect(lost.actions[0]?.action).toBe("skipped_claimed_by_other");

    const started = await healPlanChangeAftereffects({
      listOnline: async () => [{ id: "biz-2", tier: "starter", hostinger_vps_id: "10" }],
      getSubscription: async () => ({ status: "canceled", tier: "starter" } as never),
      updateTier: vi.fn(),
      countAssigned: async () => 0,
      getInventoryByVmId: async () => pooledRow(10),
      claimSpecific: vi.fn().mockResolvedValue(assignedRow(10, "biz-2")),
      startVirtualMachine: vi.fn().mockRejectedValue(new Error("hostinger 500")),
      waitHeartbeat
    });
    expect(started.actions.map((a) => a.action)).toContain("reclaimed_pooled_vm");
    expect(started.actions.map((a) => a.detail)).toContain("stale");
  });

  it("caps assignment heals at one per tick and swallows a per-tenant throw", async () => {
    const claimSpecific = vi.fn().mockResolvedValue(assignedRow(1, "biz-a"));
    const result = await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-throw", tier: "starter", hostinger_vps_id: "1" },
        { id: "biz-a", tier: "starter", hostinger_vps_id: "2" },
        { id: "biz-b", tier: "starter", hostinger_vps_id: "3" }
      ],
      getSubscription: async () => ({ status: "active", tier: "starter" } as never),
      updateTier: vi.fn(),
      countAssigned: async (id) => {
        if (id === "biz-throw") throw new Error("count down");
        return 0;
      },
      getInventoryByVmId: async () => pooledRow(2),
      claimSpecific,
      startVirtualMachine: vi.fn(),
      waitHeartbeat: vi.fn().mockResolvedValue({
        healthy: true,
        heartbeatAt: "now",
        restarted: false
      })
    });
    expect(claimSpecific).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(3);
  });

  it("returns scanned 0 when the online list fails", async () => {
    const result = await healPlanChangeAftereffects({
      listOnline: async () => {
        throw new Error("db down");
      }
    });
    expect(result).toEqual({ scanned: 0, actions: [] });
    const stringThrow = await healPlanChangeAftereffects({
      listOnline: async () => {
        throw "list exploded";
      }
    });
    expect(stringThrow).toEqual({ scanned: 0, actions: [] });
  });

  it("still reclaims when tier sync throws", async () => {
    const claimSpecific = vi.fn().mockResolvedValue(assignedRow(1936826, "biz-kin"));
    const result = await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-kin", tier: "standard", hostinger_vps_id: "1936826" }
      ],
      getSubscription: async () => {
        throw new Error("sub down");
      },
      updateTier: vi.fn(),
      countAssigned: async () => 0,
      getInventoryByVmId: async () => pooledRow(1936826),
      claimSpecific,
      startVirtualMachine: vi.fn(),
      waitHeartbeat: vi.fn().mockResolvedValue({
        healthy: true,
        heartbeatAt: "now",
        restarted: false
      })
    });
    expect(claimSpecific).toHaveBeenCalledWith(1936826, "biz-kin");
    expect(result.actions.map((a) => a.action)).toContain("reclaimed_pooled_vm");
  });

  it("heals an admin-written enterprise row the same way as self-serve tiers", async () => {
    const updateTier = vi.fn().mockResolvedValue({ tier: "enterprise" });
    await healPlanChangeAftereffects({
      listOnline: async () => [
        { id: "biz-ent", tier: "standard", hostinger_vps_id: "8" }
      ],
      getSubscription: async () => ({ status: "active", tier: "enterprise" } as never),
      updateTier,
      countAssigned: async () => 1,
      getInventoryByVmId: async () => assignedRow(8, "biz-ent"),
      claimSpecific: vi.fn(),
      startVirtualMachine: vi.fn(),
      waitHeartbeat: vi.fn()
    });
    expect(updateTier).toHaveBeenCalledWith("biz-ent", "enterprise");
  });
});
