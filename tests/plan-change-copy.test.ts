import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../messages/en.json";
import {
  entitlementBillingMismatch,
  formatPlanChangePaidThroughDate,
  parseablePaidThroughIso,
  planChangeConfirmHardwareKey,
  planChangeHardwareStory,
  planChangeSuccessBannerKey,
  showServerPrepaidLine,
  STARTER_DOWNGRADE_LOSS_CATALOG_KEYS,
  STARTER_DOWNGRADE_LOSS_IDS,
  starterDowngradeLossIds
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

describe("starterDowngradeLossIds", () => {
  it("is empty unless the confirm is a cut onto Starter", () => {
    expect(starterDowngradeLossIds("standard", "starter").length).toBeGreaterThan(0);
    expect(starterDowngradeLossIds("starter", "standard")).toEqual([]);
    expect(starterDowngradeLossIds("starter", "starter")).toEqual([]);
    expect(starterDowngradeLossIds("standard", "standard")).toEqual([]);
  });

  it("lists webhook, API-key, and other already-gated Standard surfaces", () => {
    const ids = starterDowngradeLossIds("standard", "starter");
    expect(ids).toEqual([...STARTER_DOWNGRADE_LOSS_IDS]);
    expect(ids[0]).toBe("incoming_webhooks");
    expect(ids[1]).toBe("api_keys");
    expect(ids).toContain("messenger_and_widget");
    expect(ids).toContain("outbound_ai_calls");
    expect(ids).toContain("prospecting");
    expect(ids).toContain("scheduled_outreach");
    expect(ids).toContain("team_chat_and_push");
    expect(ids).toContain("call_intel_and_browser");
    expect(ids.length).toBeGreaterThanOrEqual(8);
  });

  it("has a catalog line for every loss id, and each line names the feature", () => {
    const catalog = en.dashboard.planCard;
    for (const id of STARTER_DOWNGRADE_LOSS_IDS) {
      const key = STARTER_DOWNGRADE_LOSS_CATALOG_KEYS[id];
      const line = catalog[key];
      expect(typeof line, key).toBe("string");
      expect(line.length, key).toBeGreaterThan(20);
    }
    expect(catalog.lossIncomingWebhooks).toMatch(/Zapier/);
    expect(catalog.lossIncomingWebhooks).toMatch(/Meta/);
    expect(catalog.lossIncomingWebhooks).toMatch(/REST/);
    expect(catalog.lossApiKeys).toMatch(/API key/i);
    expect(catalog.confirmStarterLossLead).toMatch(/stop immediately/i);
    expect(catalog.confirmStarterLossKeep).toMatch(/remain/i);
  });

  it("is rendered as a scannable list on the change-plan confirm sheet", () => {
    const source = readFileSync(
      join(__dirname, "../src/components/billing/ChangePlanSelector.tsx"),
      "utf8"
    );
    expect(source).toContain("starterDowngradeLossIds");
    expect(source).toContain("confirmStarterLossLead");
    expect(source).toContain("<ul");
    expect(source).toContain("lossIncomingWebhooks");
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
