import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../messages/en.json";
import {
  entitlementBillingMismatch,
  formatPlanChangePaidThroughDate,
  parseablePaidThroughIso,
  planChangeConfirmPreview,
  planChangeSuccessBannerKey,
  showServerPrepaidLine,
  STARTER_DOWNGRADE_KEEP_CATALOG_KEYS,
  STARTER_DOWNGRADE_KEEP_IDS,
  STARTER_DOWNGRADE_LOSS_CATALOG_KEYS,
  STARTER_DOWNGRADE_LOSS_IDS
} from "@/lib/billing/plan-change-copy";

const NOW_MS = Date.parse("2026-09-18T15:25:00.000Z");
const FUTURE_EXPIRY = "2026-09-28T00:00:00.000Z";
const PAST_EXPIRY = "2026-09-18T15:24:00.000Z";

describe("planChangeConfirmPreview hardware key", () => {
  it("same-tier period switches stay on the current server", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "starter",
        selectedTier: "starter",
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmSameTier");
  });

  it("keeps the box on Standard → Starter while prepaid time remains (KIN)", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "standard",
        selectedTier: "starter",
        vpsSizePin: "kvm2",
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmKeepDated");
  });

  it("keeps the box on Starter → Standard while prepaid time remains", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "starter",
        selectedTier: "standard",
        expiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmKeepDated");
  });

  it("migrates a lapsed unpinned Standard kvm8 box down to Starter", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "standard",
        selectedTier: "starter",
        vpsSizePin: null,
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmMigrate");
  });

  it("keeps same-size hardware after lapse instead of promising a migrate", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "starter",
        selectedTier: "standard",
        vpsSizePin: "kvm2",
        expiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmKeepSameHardware");
  });

  it("migrates when there is no live box even if sizes would match", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "starter",
        selectedTier: "standard",
        vpsSizePin: "kvm2",
        expiresAt: PAST_EXPIRY,
        hasLiveBox: false,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmMigrate");
  });

  it("uses generic keep copy when expiry is unknown", () => {
    expect(
      planChangeConfirmPreview({
        currentTier: "starter",
        selectedTier: "standard",
        expiresAt: null,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("confirmKeepGeneric");
  });
});

describe("starterDowngradeLossIds", () => {
  it("is empty unless the confirm is a cut onto Starter", () => {
    expect(
      planChangeConfirmPreview({ currentTier: "standard", selectedTier: "starter" }).lossIds.length
    ).toBeGreaterThan(0);
    expect(
      planChangeConfirmPreview({ currentTier: "starter", selectedTier: "standard" }).lossIds
    ).toEqual([]);
    expect(
      planChangeConfirmPreview({ currentTier: "starter", selectedTier: "starter" }).lossIds
    ).toEqual([]);
    expect(
      planChangeConfirmPreview({ currentTier: "standard", selectedTier: "standard" }).lossIds
    ).toEqual([]);
  });

  it("lists webhook, API-key, and other already-gated Standard surfaces", () => {
    const ids = planChangeConfirmPreview({
      currentTier: "standard",
      selectedTier: "starter"
    }).lossIds;
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
    expect(catalog.confirmStarterWebhookKeep).toMatch(/stay saved/i);
    expect(catalog.confirmStarterWebhookKeep).toMatch(/stop receiving/i);
    expect(catalog.keepSavedConfig).toMatch(/Nothing is deleted/i);
  });

  it("is rendered as a scannable list on the change-plan confirm sheet", () => {
    const source = readFileSync(
      join(__dirname, "../src/components/billing/ChangePlanSelector.tsx"),
      "utf8"
    );
    expect(source).toContain("planChangeConfirmPreview");
    expect(source).toContain("confirmStarterLossLead");
    expect(source).toContain("confirmKeepLead");
    expect(source).toContain("confirmStarterWebhookKeep");
    expect(source).toContain("confirmPriceLabel");
    expect(source).toContain("confirmTimingLabel");
    expect(source).toContain("confirmEntitlementsNow");
    expect(source).toContain("confirmStandardPerksStopNow");
    expect(source).toContain("<ul");
    expect(source).toContain("lossIncomingWebhooks");
  });
});

describe("starterDowngradeKeepIds", () => {
  it("is empty unless the confirm is a cut onto Starter", () => {
    expect(
      planChangeConfirmPreview({ currentTier: "standard", selectedTier: "starter" }).keepIds
    ).toEqual([...STARTER_DOWNGRADE_KEEP_IDS]);
    expect(
      planChangeConfirmPreview({ currentTier: "starter", selectedTier: "standard" }).keepIds
    ).toEqual([]);
    expect(
      planChangeConfirmPreview({ currentTier: "starter", selectedTier: "starter" }).keepIds
    ).toEqual([]);
    expect(
      planChangeConfirmPreview({ currentTier: "standard", selectedTier: "standard" }).keepIds
    ).toEqual([]);
  });

  it("has a catalog line for every keep id", () => {
    const catalog = en.dashboard.planCard;
    for (const id of STARTER_DOWNGRADE_KEEP_IDS) {
      const key = STARTER_DOWNGRADE_KEEP_CATALOG_KEYS[id];
      const line = catalog[key];
      expect(typeof line, key).toBe("string");
      expect(line.length, key).toBeGreaterThan(10);
    }
    expect(catalog.keepInboundVoiceSms).toMatch(/voice/i);
    expect(catalog.keepBookingEmailChat).toMatch(/booking/i);
    expect(catalog.keepKnowledgeAndLimits).toMatch(/Knowledge/i);
  });
});

describe("planChangeConfirmPreview", () => {
  it("lists destination, retain vs lose, and entitlement-now on Standard to Starter", () => {
    const preview = planChangeConfirmPreview({
      currentTier: "standard",
      selectedTier: "starter",
      expiresAt: FUTURE_EXPIRY,
      nowMs: NOW_MS
    });
    expect(preview.destinationTier).toBe("starter");
    expect(preview.showsEntitlementFlipNow).toBe(true);
    expect(preview.showsStarterFeatureSplit).toBe(true);
    expect(preview.hardwareKey).toBe("confirmKeepDated");
    expect(preview.lossIds).toEqual([...STARTER_DOWNGRADE_LOSS_IDS]);
    expect(preview.keepIds).toEqual([...STARTER_DOWNGRADE_KEEP_IDS]);
  });

  it("flips entitlements on Starter to Standard without a feature-loss list", () => {
    const preview = planChangeConfirmPreview({
      currentTier: "starter",
      selectedTier: "standard",
      expiresAt: FUTURE_EXPIRY,
      nowMs: NOW_MS
    });
    expect(preview.destinationTier).toBe("standard");
    expect(preview.showsEntitlementFlipNow).toBe(true);
    expect(preview.showsStarterFeatureSplit).toBe(false);
    expect(preview.lossIds).toEqual([]);
    expect(preview.keepIds).toEqual([]);
  });

  it("does not claim an entitlement flip on a same-tier period switch", () => {
    const preview = planChangeConfirmPreview({
      currentTier: "standard",
      selectedTier: "standard",
      expiresAt: FUTURE_EXPIRY,
      nowMs: NOW_MS
    });
    expect(preview.showsEntitlementFlipNow).toBe(false);
    expect(preview.showsStarterFeatureSplit).toBe(false);
    expect(preview.hardwareKey).toBe("confirmSameTier");
    expect(preview.lossIds).toEqual([]);
    expect(preview.keepIds).toEqual([]);
  });
});

describe("confirm catalog honesty", () => {
  it("hardware copy is box-only and does not imply Standard features last until period end", () => {
    const catalog = en.dashboard.planCard;
    for (const key of [
      "confirmKeepDated",
      "confirmKeepGeneric",
      "confirmKeepSameHardware",
      "confirmMigrate"
    ] as const) {
      expect(catalog[key]).not.toMatch(/plan and features change now/i);
      expect(catalog[key]).not.toMatch(/until the end of your (current )?period/i);
    }
    expect(catalog.confirmKeepDated).toMatch(/Hostinger/);
    expect(catalog.confirmEntitlementsNow).toMatch(/immediately/i);
    expect(catalog.confirmEntitlementsNow).toMatch(/not at the end/i);
    expect(catalog.confirmStandardPerksStopNow).toMatch(/immediately/i);
    expect(catalog.confirmStandardPerksStopNow).toMatch(/does not keep/i);
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
