import { describe, expect, it } from "vitest";

import {
  boxHasPaidTimeLeft,
  planChangeCutoverDecision,
  shouldMigrateHardwareForPlanChange
} from "@/lib/billing/plan-change-hardware";
import { resolveDeployedVpsSize, resolveVpsSize } from "@/lib/vps/size";

const NOW_MS = Date.parse("2026-09-18T15:25:00.000Z");
const FUTURE_EXPIRY = "2026-09-28T00:00:00.000Z";
const PAST_EXPIRY = "2026-09-18T15:24:00.000Z";
const AT_EXPIRY = "2026-09-18T15:25:00.000Z";

describe("boxHasPaidTimeLeft", () => {
  it("treats a future expires_at as prepaid time (KIN 2026-09-28)", () => {
    expect(boxHasPaidTimeLeft(FUTURE_EXPIRY, NOW_MS)).toBe(true);
  });

  it("treats at-or-past expiry as lapsed", () => {
    expect(boxHasPaidTimeLeft(AT_EXPIRY, NOW_MS)).toBe(false);
    expect(boxHasPaidTimeLeft(PAST_EXPIRY, NOW_MS)).toBe(false);
  });

  it("fails toward keep when expiry is missing or unreadable", () => {
    expect(boxHasPaidTimeLeft(null, NOW_MS)).toBe(true);
    expect(boxHasPaidTimeLeft(undefined, NOW_MS)).toBe(true);
    expect(boxHasPaidTimeLeft("", NOW_MS)).toBe(true);
    expect(boxHasPaidTimeLeft("not-a-date", NOW_MS)).toBe(true);
  });
});

describe("shouldMigrateHardwareForPlanChange", () => {
  it("skips Standard → Starter when a kvm2 pin keeps the same box (KIN)", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: "kvm2",
        termAlignment: false,
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(false);
    expect(resolveDeployedVpsSize("standard", "kvm2")).toBe("kvm2");
    expect(resolveVpsSize("starter", "kvm2")).toBe("kvm2");
  });

  it("skips Starter → Standard when both sides resolve to kvm2 (upgrade, no pin)", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "standard",
        vpsSizePin: null,
        termAlignment: false,
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(false);
  });

  it("keeps an unpinned Standard kvm8 on Starter while the box still has paid time", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false,
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(false);
  });

  it("migrates a lapsed unpinned Standard kvm8 box down to Starter kvm1", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(true);
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false,
        expiresAt: AT_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(true);
    expect(resolveDeployedVpsSize("standard", null)).toBe("kvm8");
    expect(resolveVpsSize("starter", null)).toBe("kvm1");
  });

  it("does not term-align while the live box still has prepaid time", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "starter",
        vpsSizePin: "kvm2",
        termAlignment: true,
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(false);
  });

  it("still migrates a lapsed same-size term alignment onto a newly bought box", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "starter",
        vpsSizePin: "kvm2",
        termAlignment: true,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(true);
  });

  it("provisions when there is no live box even if expiry is unknown", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false,
        hasLiveBox: false,
        expiresAt: null,
        nowMs: NOW_MS
      })
    ).toBe(true);
  });

  it("does not migrate a same-tier switch that is not term-aligning", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "standard",
        newTier: "standard",
        vpsSizePin: "kvm2",
        termAlignment: false,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(false);
  });

  it("does not migrate a same-tier Starter period switch even when deployed kvm2 disagrees with the new kvm1 default", () => {
    expect(
      shouldMigrateHardwareForPlanChange({
        oldTier: "starter",
        newTier: "starter",
        vpsSizePin: null,
        termAlignment: false,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe(false);
  });
});

const assignedToKin = { state: "assigned", assigned_business_id: "biz-kin" };

describe("planChangeCutoverDecision", () => {
  it("refuses to pool the live box when provision reused it (KIN)", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1936826,
        newVpsId: "1936826",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("refuses when the new VM's inventory is pooled, not assigned", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1936826,
        newVpsId: "2000001",
        deploySucceeded: true,
        inventoryRow: { state: "available", assigned_business_id: null },
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("refuses when deploy failed or the voice bridge is not heartbeating", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: false,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: false,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("refuses to pool a box that still has prepaid time, even if a replacement exists", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: FUTURE_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("refuses missing, non-numeric, or non-positive replacement ids", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: null,
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      }).releaseOldBox
    ).toBe(false);
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "new-box",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      }).releaseOldBox
    ).toBe(false);
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "0",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      }).releaseOldBox
    ).toBe(false);
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 0,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      }).releaseOldBox
    ).toBe(false);
  });

  it("refuses when the replacement is assigned to a different business", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: { state: "assigned", assigned_business_id: "someone-else" },
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

  it("is not complete when migrating without an old VM and the new id is missing", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: null,
        newVpsId: null,
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        businessId: "biz-kin",
        heartbeatHealthy: true
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });

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

  it("releases the old box only when a lapsed same-size move landed on a different assigned VM", () => {
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1001,
        newVpsId: "2002",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: true, cutoverReady: true });
    expect(
      planChangeCutoverDecision({
        migrateVps: true,
        oldVmId: 1936826,
        newVpsId: "1936826",
        deploySucceeded: true,
        inventoryRow: assignedToKin,
        oldExpiresAt: PAST_EXPIRY,
        businessId: "biz-kin",
        heartbeatHealthy: true,
        nowMs: NOW_MS
      })
    ).toEqual({ releaseOldBox: false, cutoverReady: false });
  });
});
