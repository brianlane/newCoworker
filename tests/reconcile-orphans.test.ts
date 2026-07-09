import { describe, expect, it, vi } from "vitest";
import {
  normalizeHostingerPlan,
  reconcileOrphanedPurchases,
  ORPHAN_MAX_AGE_MS
} from "@/lib/provisioning/reconcile-orphans";
import type { VirtualMachine } from "@/lib/hostinger/client";

const NOW = Date.parse("2026-07-08T23:00:00Z");

function vm(overrides: Partial<VirtualMachine> & { id: number }): VirtualMachine {
  return {
    state: "initial",
    plan: "KVM 2",
    hostname: `srv${overrides.id}.hstgr.cloud`,
    created_at: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min old
    ...overrides
  } as VirtualMachine;
}

describe("normalizeHostingerPlan", () => {
  it("maps Hostinger's human labels to VpsSize slugs", () => {
    expect(normalizeHostingerPlan("KVM 2")).toBe("kvm2");
    expect(normalizeHostingerPlan("KVM 1")).toBe("kvm1");
    expect(normalizeHostingerPlan("kvm8")).toBe("kvm8");
    expect(normalizeHostingerPlan("KVM-4")).toBe("kvm4");
  });

  it("returns null for unknown or missing plans", () => {
    expect(normalizeHostingerPlan("Cloud Startup")).toBeNull();
    expect(normalizeHostingerPlan("KVM 16")).toBeNull();
    expect(normalizeHostingerPlan("")).toBeNull();
    expect(normalizeHostingerPlan(undefined)).toBeNull();
    expect(normalizeHostingerPlan(null)).toBeNull();
  });
});

describe("reconcileOrphanedPurchases", () => {
  function makeArgs(overrides: Partial<Parameters<typeof reconcileOrphanedPurchases>[0]> = {}) {
    return {
      businessId: "biz-orphan-1",
      listVirtualMachines: vi.fn().mockResolvedValue([]),
      listInventory: vi.fn().mockResolvedValue([]),
      release: vi.fn().mockResolvedValue(undefined),
      now: () => NOW,
      ...overrides
    };
  }

  it("pools a recent unknown VM and returns it with its normalized plan", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 1815606, subscription_id: "AzywqVVOpCob62ZiY" })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([{ vmId: 1815606, plan: "kvm2" }]);
    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1815606,
        plan: "kvm2",
        hostname: "srv1815606.hstgr.cloud",
        hostingerBillingSubscriptionId: "AzywqVVOpCob62ZiY",
        notes: expect.stringContaining("orphaned purchase reconciled for biz-orphan-1")
      })
    );
  });

  it("skips VMs already tracked in vps_inventory (any state, including retired)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 100 }), vm({ id: 200 })]),
      listInventory: vi.fn().mockResolvedValue([{ vm_id: 100 }])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([{ vmId: 200, plan: "kvm2" }]);
    expect(args.release).toHaveBeenCalledTimes(1);
  });

  it("skips running/installing VMs (may belong to a live tenant or in-flight provision)", async () => {
    // Bugbot High: a `running` box whose post-purchase pool bookkeeping
    // failed is a live tenant box — pooling it would let another signup
    // recreate it. Only the fail-but-charge signature (`initial`, no
    // template) is safe to reclaim.
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 210, state: "running" }),
        vm({ id: 211, state: "installing" }),
        vm({ id: 212, state: "initial" })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([{ vmId: 212, plan: "kvm2" }]);
    expect(args.release).toHaveBeenCalledTimes(1);
  });

  it("skips an initial VM that already has a template applied (setup ran — not fail-but-charge)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 220, template: { id: 1121, name: "Ubuntu 24.04 with Docker" } })
      ])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("skips VMs older than the recency window (legacy strays must never auto-pool)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 300, created_at: new Date(NOW - ORPHAN_MAX_AGE_MS - 1000).toISOString() }),
        // Exactly at the boundary is still inside the window.
        vm({ id: 301, created_at: new Date(NOW - ORPHAN_MAX_AGE_MS).toISOString() })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([{ vmId: 301, plan: "kvm2" }]);
  });

  it("skips VMs with a missing or unparseable created_at", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 400, created_at: undefined }),
        vm({ id: 401, created_at: "not-a-date" })
      ])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("skips VMs with an unrecognized plan (can't size-match for adopt)", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 500, plan: "Game Panel 1" })])
    });

    expect(await reconcileOrphanedPurchases(args)).toEqual([]);
    expect(args.release).not.toHaveBeenCalled();
  });

  it("passes a null subscription id through when Hostinger omits it", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([vm({ id: 600, subscription_id: undefined })])
    });

    await reconcileOrphanedPurchases(args);

    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: 600, hostingerBillingSubscriptionId: null })
    );
  });

  it("defaults the clock to Date.now() and hostname to null when Hostinger omits it", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({
          id: 800,
          hostname: undefined,
          created_at: new Date(Date.now() - 60_000).toISOString()
        })
      ]),
      now: undefined
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([{ vmId: 800, plan: "kvm2" }]);
    expect(args.release).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: 800, hostname: null })
    );
  });

  it("pools multiple orphans in one pass", async () => {
    const args = makeArgs({
      listVirtualMachines: vi.fn().mockResolvedValue([
        vm({ id: 700, plan: "KVM 1" }),
        vm({ id: 701, plan: "KVM 2" })
      ])
    });

    const result = await reconcileOrphanedPurchases(args);

    expect(result).toEqual([
      { vmId: 700, plan: "kvm1" },
      { vmId: 701, plan: "kvm2" }
    ]);
    expect(args.release).toHaveBeenCalledTimes(2);
  });
});
