import { describe, expect, it } from "vitest";

import {
  canReleaseOldVpsForPlanChange,
  inventoryAssignedToBusiness,
  isReplacementVm,
  planChangeCutoverDecision,
  resolvedHardwareForPlanChange,
  shouldMigrateHardwareForPlanChange
} from "@/lib/billing/plan-change-hardware";

describe("shouldMigrateHardwareForPlanChange", () => {
  it("skips Standard → Starter when a kvm2 pin keeps the same box (KIN)", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: "kvm2",
        termAlignment: false
      })
    ).toBe(false);
    expect(resolvedHardwareForPlanChange("standard", "starter", "kvm2")).toEqual({
      fromHardware: "kvm2",
      toHardware: "kvm2"
    });
  });

  it("skips Starter → Standard when both sides resolve to kvm2 (upgrade, no pin)", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "standard",
        vpsSizePin: null,
        termAlignment: false
      })
    ).toBe(false);
  });

  it("migrates a legacy unpinned Standard kvm8 box down to Starter kvm1", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false
      })
    ).toBe(true);
    expect(resolvedHardwareForPlanChange("standard", "starter", null)).toEqual({
      fromHardware: "kvm8",
      toHardware: "kvm1"
    });
  });

  it("still migrates a same-size term alignment onto a newly bought box", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "starter",
        vpsSizePin: "kvm2",
        termAlignment: true
      })
    ).toBe(true);
  });

  it("does not migrate a same-tier switch that is not term-aligning", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "standard",
        vpsSizePin: "kvm2",
        termAlignment: false
      })
    ).toBe(false);
  });

  it("does not migrate a same-tier Starter period switch even when deployed kvm2 disagrees with the new kvm1 default", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false
      })
    ).toBe(false);
  });
});

describe("isReplacementVm", () => {
  it("rejects reusing the live box as if it were a replacement (KIN)", () => {
    expect(isReplacementVm(1936826, "1936826")).toBe(false);
  });

  it("accepts a different numeric VM", () => {
    expect(isReplacementVm(1936826, "2000001")).toBe(true);
  });

  it("rejects missing, non-numeric, or non-positive ids", () => {
    expect(isReplacementVm(null, "2002")).toBe(false);
    expect(isReplacementVm(1001, null)).toBe(false);
    expect(isReplacementVm(1001, "new-box")).toBe(false);
    expect(isReplacementVm(1001, "0")).toBe(false);
  });
});

describe("inventoryAssignedToBusiness", () => {
  it("requires state=assigned AND this business id (not a stale hostinger_vps_id)", () => {
    expect(
      inventoryAssignedToBusiness(
        { state: "available", assigned_business_id: null },
        "biz-kin"
      )
    ).toBe(false);
    expect(
      inventoryAssignedToBusiness(
        { state: "assigned", assigned_business_id: "someone-else" },
        "biz-kin"
      )
    ).toBe(false);
    expect(
      inventoryAssignedToBusiness(
        { state: "assigned", assigned_business_id: "biz-kin" },
        "biz-kin"
      )
    ).toBe(true);
    expect(inventoryAssignedToBusiness(null, "biz-kin")).toBe(false);
  });
});

const assignedToKin = { state: "assigned", assigned_business_id: "biz-kin" };

describe("canReleaseOldVpsForPlanChange", () => {
  it("refuses to pool the live box when provision reused it (KIN)", () => {
    expect(
      canReleaseOldVpsForPlanChange({
        oldVmId: 1936826,
        newVpsId: "1936826",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toBe(false);
  });

  it("refuses when the new VM's inventory is pooled, not assigned", () => {
    expect(
      canReleaseOldVpsForPlanChange({
        oldVmId: 1936826,
        newVpsId: "2000001",
        deploySucceeded: true,
        inventoryRow: { state: "available", assigned_business_id: null },
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toBe(false);
  });

  it("refuses when deploy failed or the voice bridge is not heartbeating", () => {
    expect(
      canReleaseOldVpsForPlanChange({
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: false,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toBe(false);
    expect(
      canReleaseOldVpsForPlanChange({
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: false
      })
    ).toBe(false);
  });

  it("allows teardown only for a different assigned VM with a live bridge", () => {
    expect(
      canReleaseOldVpsForPlanChange({
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toBe(true);
  });
});

describe("planChangeCutoverDecision", () => {
  it("keeps the live box on an entitlement-only same-size change", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: false,
        oldVmId: 1936826,
        newVpsId: null,
        deploySucceeded: undefined,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: true });
  });

  it("is not complete when the voice bridge is stale, even if hardware did not move", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: false,
        oldVmId: 1936826,
        newVpsId: null,
        deploySucceeded: undefined,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: false
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("is not complete when the pointed-at VM is pooled (KIN: available, unassigned)", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: false,
        oldVmId: 1936826,
        newVpsId: null,
        deploySucceeded: undefined,
        inventoryRow: { state: "available", assigned_business_id: null },
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("treats heartbeat as enough when there is no inventory row to contradict the pointer", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: false,
        oldVmId: 1936826,
        newVpsId: null,
        deploySucceeded: undefined,
        inventoryRow: null,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: true });
  });

  it("is not complete when migrating onto a box whose deploy failed, with no old VM to compare", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: null,
        newVpsId: "2002",
        deploySucceeded: false,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("requires an assigned new VM when migrating without an old box to compare", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: null,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: true });
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: null,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: { state: "available", assigned_business_id: null },
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("releases the old box only when a same-size move landed on a different assigned VM", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: true, cutoverReady: true });
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1936826,
        newVpsId: "1936826",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });
});
