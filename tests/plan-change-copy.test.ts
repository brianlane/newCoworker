import { describe, expect, it } from "vitest";

import {
  entitlementBillingMismatch,
  formatPlanChangePaidThroughDate,
  parseablePaidThroughIso,
  planChangeConfirmHardwareKey,
  planChangeHardwareStory,
  planChangeSuccessBannerKey,
  planChangeWarnsStarterWebhooks,
  showServerPrepaidLine
} from "@/lib/billing/plan-change-copy";

const NOW_MS = Date.parse("2026-09-18T15:25:00.000Z");
const FUTURE_EXPIRY = "2026-09-28T00:00:00.000Z";
const PAST_EXPIRY = "2026-09-18T15:24:00.000Z";

describe("planChangeHardwareStory", () => {
  it("same-tier period switches stay on the current server", () => {
    expect(
      planChangeHardwareStory({
        currentTier: "starter",
        selectedTier: "starter",
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("same_tier");
  });

  it("keeps the box on Standard → Starter while prepaid time remains (KIN)", () => {
    expect(
      planChangeHardwareStory({
        currentTier: "standard",
        selectedTier: "starter",
        vpsSizePin: "kvm2",
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("keep_until_lapse");
  });

  it("keeps the box on Starter → Standard while prepaid time remains", () => {
    expect(
      planChangeHardwareStory({
        currentTier: "starter",
        selectedTier: "standard",
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("keep_until_lapse");
  });

  it("migrates a lapsed unpinned Standard kvm8 box down to Starter", () => {
    expect(
      planChangeHardwareStory({
        currentTier: "standard",
        selectedTier: "starter",
        vpsSizePin: null,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("migrate_now");
  });

  it("keeps same-size hardware after lapse instead of promising a migrate", () => {
    expect(
      planChangeHardwareStory({
        currentTier: "starter",
        selectedTier: "standard",
        vpsSizePin: "kvm2",
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("keep_same_hardware");
  });

  it("migrates when there is no live box even if sizes would match", () => {
    expect(
      planChangeHardwareStory({
        currentTier: "starter",
        selectedTier: "standard",
        vpsSizePin: "kvm2",
        expiresAt: PAST_EXPIRY,
        hasLiveBox: false,
        nowMs: NOW_MS
      })
    ).toBe("migrate_now");
  });
});

describe("planChangeConfirmHardwareKey", () => {
  it("names the keep-until-lapse day when prepaid time is parseable", () => {
    expect(
      planChangeConfirmHardwareKey({
        currentTier: "standard",
        selectedTier: "starter",
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("confirmKeepDated");
  });

  it("uses generic keep copy when expiry is unknown", () => {
    expect(
      planChangeConfirmHardwareKey({
        currentTier: "starter",
        selectedTier: "standard",
        expiresAt: null,
        nowMs: NOW_MS
      })
    ).toBe("confirmKeepGeneric");
  });

  it("branches same-tier, migrate, and same-size stay", () => {
    expect(
      planChangeConfirmHardwareKey({
        currentTier: "standard",
        selectedTier: "standard",
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("confirmSameTier");
    expect(
      planChangeConfirmHardwareKey({
        currentTier: "standard",
        selectedTier: "starter",
        vpsSizePin: null,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("confirmMigrate");
    expect(
      planChangeConfirmHardwareKey({
        currentTier: "starter",
        selectedTier: "standard",
        vpsSizePin: "kvm2",
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      })
    ).toBe("confirmKeepSameHardware");
  });
});

describe("planChangeWarnsStarterWebhooks", () => {
  it("warns only when downgrading onto Starter", () => {
    expect(planChangeWarnsStarterWebhooks("standard", "starter")).toBe(true);
    expect(planChangeWarnsStarterWebhooks("starter", "standard")).toBe(false);
    expect(planChangeWarnsStarterWebhooks("starter", "starter")).toBe(false);
    expect(planChangeWarnsStarterWebhooks("standard", "standard")).toBe(false);
  });
});

describe("planChangeSuccessBannerKey", () => {
  it("names the paid-through day when the live box still has prepaid time", () => {
    expect(planChangeSuccessBannerKey(FUTURE_EXPIRY, NOW_MS)).toBe("planChangedKeepDated");
  });

  it("uses generic keep copy when expiry is unknown", () => {
    expect(planChangeSuccessBannerKey(null, NOW_MS)).toBe("planChangedKeepGeneric");
    expect(planChangeSuccessBannerKey("not-a-date", NOW_MS)).toBe("planChangedKeepGeneric");
    expect(planChangeSuccessBannerKey("", NOW_MS)).toBe("planChangedKeepGeneric");
  });

  it("uses migrate copy when the box is at or past expiry", () => {
    expect(planChangeSuccessBannerKey(PAST_EXPIRY, NOW_MS)).toBe("planChangedMigrate");
  });
});

describe("parseablePaidThroughIso / format / prepaid line", () => {
  it("returns the ISO only for a parseable future expiry", () => {
    expect(parseablePaidThroughIso(FUTURE_EXPIRY, NOW_MS)).toBe(FUTURE_EXPIRY);
    expect(parseablePaidThroughIso(PAST_EXPIRY, NOW_MS)).toBeNull();
    expect(parseablePaidThroughIso(null, NOW_MS)).toBeNull();
    expect(parseablePaidThroughIso("nope", NOW_MS)).toBeNull();
  });

  it("formats a paid-through day in English and Spanish", () => {
    expect(formatPlanChangePaidThroughDate(FUTURE_EXPIRY, "en")).toBe("September 28, 2026");
    expect(formatPlanChangePaidThroughDate(FUTURE_EXPIRY, "es")?.toLowerCase()).toContain("septiembre");
    expect(formatPlanChangePaidThroughDate("nope", "en")).toBeNull();
  });

  it("shows the billing prepaid line while the box still has time left", () => {
    expect(showServerPrepaidLine(FUTURE_EXPIRY, NOW_MS)).toBe(true);
    expect(showServerPrepaidLine(null, NOW_MS)).toBe(true);
    expect(showServerPrepaidLine(PAST_EXPIRY, NOW_MS)).toBe(false);
    expect(showServerPrepaidLine(FUTURE_EXPIRY, NOW_MS, false)).toBe(false);
  });
});

describe("entitlementBillingMismatch", () => {
  it("is true only when both tiers are present and differ", () => {
    expect(entitlementBillingMismatch("starter", "standard")).toBe(true);
    expect(entitlementBillingMismatch("starter", "starter")).toBe(false);
    expect(entitlementBillingMismatch("starter", null)).toBe(false);
    expect(entitlementBillingMismatch(null, "standard")).toBe(false);
    expect(entitlementBillingMismatch("", "standard")).toBe(false);
  });
});
