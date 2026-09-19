import { describe, expect, it } from "vitest";

import en from "../messages/en.json";
import {
  CANCEL_KEEP_CATALOG_KEYS,
  CANCEL_KEEP_IDS,
  CANCEL_LOSS_CATALOG_KEYS,
  CANCEL_LOSS_CORE_IDS,
  cancelConfirmModeForReason,
  cancelConfirmPreview,
  cancelLossIdsForTier,
  cancelReasonShowsKeepLose
} from "@/lib/billing/cancel-copy";
import { STARTER_DOWNGRADE_LOSS_IDS } from "@/lib/billing/plan-change-copy";

const NOW_MS = Date.parse("2026-09-18T15:25:00.000Z");
const FUTURE_EXPIRY = "2026-09-28T00:00:00.000Z";
const PAST_EXPIRY = "2026-09-18T15:24:00.000Z";

describe("cancelLossIdsForTier", () => {
  it("lists core losses on Starter and when the tier is unknown", () => {
    expect(cancelLossIdsForTier("starter")).toEqual([...CANCEL_LOSS_CORE_IDS]);
    expect(cancelLossIdsForTier(null)).toEqual([...CANCEL_LOSS_CORE_IDS]);
    expect(cancelLossIdsForTier(undefined)).toEqual([...CANCEL_LOSS_CORE_IDS]);
  });

  it("adds Standard-gated losses on Standard and enterprise", () => {
    expect(cancelLossIdsForTier("standard")).toEqual([
      ...CANCEL_LOSS_CORE_IDS,
      ...STARTER_DOWNGRADE_LOSS_IDS
    ]);
    expect(cancelLossIdsForTier("enterprise")).toEqual([
      ...CANCEL_LOSS_CORE_IDS,
      ...STARTER_DOWNGRADE_LOSS_IDS
    ]);
  });
});

describe("cancelConfirmPreview", () => {
  it("always keeps saved data and reactivation", () => {
    const preview = cancelConfirmPreview({ mode: "refund", nowMs: NOW_MS });
    expect(preview.keepIds).toEqual([...CANCEL_KEEP_IDS]);
    expect(preview.mode).toBe("refund");
    expect(preview.showsStandardLosses).toBe(false);
  });

  it("flags Standard losses only on Standard or enterprise", () => {
    expect(
      cancelConfirmPreview({
        mode: "refund",
        currentTier: "standard",
        nowMs: NOW_MS
      }).showsStandardLosses
    ).toBe(true);
    expect(
      cancelConfirmPreview({
        mode: "immediate",
        currentTier: "enterprise",
        nowMs: NOW_MS
      }).showsStandardLosses
    ).toBe(true);
    expect(
      cancelConfirmPreview({
        mode: "refund",
        currentTier: "starter",
        nowMs: NOW_MS
      }).showsStandardLosses
    ).toBe(false);
  });

  it("hides Hostinger copy when there is no live box", () => {
    expect(
      cancelConfirmPreview({
        mode: "refund",
        boxExpiresAt: FUTURE_EXPIRY,
        hasLiveBox: false,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("none");
  });

  it("dates the Hostinger cliff when prepaid time remains", () => {
    expect(
      cancelConfirmPreview({
        mode: "refund",
        boxExpiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("cliffDated");
  });

  it("uses generic cliff copy when expiry is present but not prepaid-through", () => {
    expect(
      cancelConfirmPreview({
        mode: "immediate",
        boxExpiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("cliffGeneric");
    expect(
      cancelConfirmPreview({
        mode: "refund",
        boxExpiresAt: "not-a-date",
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("cliffGeneric");
  });

  it("on period-end, only names a Hostinger date when prepaid time remains", () => {
    expect(
      cancelConfirmPreview({
        mode: "period_end",
        boxExpiresAt: FUTURE_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("periodEndDated");
    expect(
      cancelConfirmPreview({
        mode: "period_end",
        boxExpiresAt: PAST_EXPIRY,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("none");
    expect(
      cancelConfirmPreview({
        mode: "period_end",
        boxExpiresAt: null,
        nowMs: NOW_MS
      }).hardwareKey
    ).toBe("none");
  });

  it("accepts a missing nowMs (runtime clock) without throwing", () => {
    const preview = cancelConfirmPreview({ mode: "refund" });
    expect(preview.keepIds).toEqual([...CANCEL_KEEP_IDS]);
    expect(preview.hardwareKey).toBe("none");
  });
});

describe("cancel reason helpers", () => {
  it("shows keep/lose on owner-facing leave reasons only", () => {
    expect(cancelReasonShowsKeepLose("user_refund")).toBe(true);
    expect(cancelReasonShowsKeepLose("user_period_end")).toBe(true);
    expect(cancelReasonShowsKeepLose("payment_failed")).toBe(true);
    expect(cancelReasonShowsKeepLose("stripe_external")).toBe(true);
    expect(cancelReasonShowsKeepLose("admin_force")).toBe(false);
    expect(cancelReasonShowsKeepLose("upgrade_switch")).toBe(false);
  });

  it("maps reasons onto confirm modes", () => {
    expect(cancelConfirmModeForReason("user_period_end")).toBe("period_end");
    expect(cancelConfirmModeForReason("user_refund")).toBe("refund");
    expect(cancelConfirmModeForReason("payment_failed")).toBe("immediate");
    expect(cancelConfirmModeForReason("stripe_external")).toBe("immediate");
    expect(cancelConfirmModeForReason("admin_force")).toBe("immediate");
  });
});

describe("cancel catalog lines", () => {
  it("has a planCard line for every keep and loss id", () => {
    const catalog = en.dashboard.planCard;
    for (const id of CANCEL_KEEP_IDS) {
      const key = CANCEL_KEEP_CATALOG_KEYS[id];
      expect(typeof catalog[key], key).toBe("string");
      expect(catalog[key].length, key).toBeGreaterThan(20);
    }
    for (const id of CANCEL_LOSS_CORE_IDS) {
      const key = CANCEL_LOSS_CATALOG_KEYS[id];
      expect(typeof catalog[key], key).toBe("string");
      expect(catalog[key].length, key).toBeGreaterThan(20);
    }
    expect(catalog.cancelLossVpsCoworker).toMatch(/VPS coworker/i);
    expect(catalog.cancelLossLeadFollowup).toMatch(/AiFlows/i);
  });
});
