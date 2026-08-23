import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_CATEGORIES,
  AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS,
  AUTO_RELOAD_THRESHOLD_BOUNDS,
  autoReloadPlatformEnabled,
  autoReloadPlatformMaxMonthlyCents,
  buildAttemptKey,
  classifyChargeFailure,
  effectiveMonthlyLimitCents,
  fromDisplayUnits,
  isAutoReloadCategory,
  isBelowThreshold,
  resolveAutoReloadPack,
  toDisplayUnits,
  validateAutoReload,
  type AutoReloadCategory
} from "@/lib/billing/auto-reload";

/**
 * Pure decision layer for auto-reload. No I/O, so every branch is reachable
 * from a plain call; `src/lib/**` is pinned at 100% coverage and this module
 * is where the money-affecting rules live (the anti-loop invariant, the
 * failure classification that decides whether a tenant gets suspended).
 */

const OLD_ENV = process.env;

/** Every pack price id configured, so the catalog is fully available. */
function configurePacks(): void {
  process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_v30";
  process.env.STRIPE_VOICE_BONUS_120MIN_PRICE_ID = "price_v120";
  process.env.STRIPE_VOICE_BONUS_600MIN_PRICE_ID = "price_v600";
  process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_s500";
  process.env.STRIPE_SMS_BONUS_2000_PRICE_ID = "price_s2000";
  process.env.STRIPE_SMS_BONUS_10000_PRICE_ID = "price_s10000";
  process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_c5";
  process.env.STRIPE_CHAT_CREDIT_10USD_PRICE_ID = "price_c10";
  process.env.STRIPE_CHAT_CREDIT_25USD_PRICE_ID = "price_c25";
}

beforeEach(() => {
  process.env = { ...OLD_ENV };
  configurePacks();
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe("isAutoReloadCategory", () => {
  it("accepts the three families and nothing else", () => {
    for (const c of AUTO_RELOAD_CATEGORIES) expect(isAutoReloadCategory(c)).toBe(true);
    expect(isAutoReloadCategory("email")).toBe(false);
    expect(isAutoReloadCategory(null)).toBe(false);
    expect(isAutoReloadCategory(7)).toBe(false);
  });
});

describe("resolveAutoReloadPack", () => {
  it("resolves each family to canonical grant units", () => {
    expect(resolveAutoReloadPack("voice", "min_30")).toMatchObject({
      packId: "min_30",
      grantUnits: 1_800,
      priceId: "price_v30"
    });
    expect(resolveAutoReloadPack("sms", "texts_500")).toMatchObject({
      packId: "texts_500",
      grantUnits: 500
    });
    expect(resolveAutoReloadPack("chat", "usd_5")).toMatchObject({
      packId: "usd_5",
      grantUnits: 5_000_000
    });
  });

  it("trims the id", () => {
    expect(resolveAutoReloadPack("sms", "  texts_500  ")?.packId).toBe("texts_500");
  });

  it("returns null for a blank id", () => {
    expect(resolveAutoReloadPack("sms", "   ")).toBeNull();
  });

  it("returns null for an unknown id in every family", () => {
    expect(resolveAutoReloadPack("voice", "min_9")).toBeNull();
    expect(resolveAutoReloadPack("sms", "texts_7")).toBeNull();
    expect(resolveAutoReloadPack("chat", "usd_3")).toBeNull();
  });

  it("fails closed when the pack's Stripe price is not configured", () => {
    // The whole point: an unconfigured pack does not exist, so a rule
    // pointing at it must refuse to arm rather than silently never firing.
    delete process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID;
    delete process.env.STRIPE_SMS_BONUS_500_PRICE_ID;
    delete process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID;
    expect(resolveAutoReloadPack("voice", "min_30")).toBeNull();
    expect(resolveAutoReloadPack("sms", "texts_500")).toBeNull();
    expect(resolveAutoReloadPack("chat", "usd_5")).toBeNull();
  });
});

describe("validateAutoReload", () => {
  const base = {
    category: "sms" as AutoReloadCategory,
    enabled: true,
    packId: "texts_500",
    thresholdUnits: 100,
    monthlyLimitCents: null as number | null
  };

  it("accepts a sane configuration", () => {
    const res = validateAutoReload(base);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pack.grantUnits).toBe(500);
  });

  it("rejects an unknown or unconfigured pack", () => {
    expect(validateAutoReload({ ...base, packId: "texts_7" })).toEqual({
      ok: false,
      error: "unknown_pack"
    });
  });

  it("rejects a threshold outside the bounds, at both edges", () => {
    const { min, max } = AUTO_RELOAD_THRESHOLD_BOUNDS.sms;
    expect(validateAutoReload({ ...base, thresholdUnits: min - 1 }).ok).toBe(false);
    expect(validateAutoReload({ ...base, thresholdUnits: max + 1 }).ok).toBe(false);
    // The bounds themselves are allowed (max needs a pack big enough to clear it).
    expect(validateAutoReload({ ...base, thresholdUnits: min }).ok).toBe(true);
    expect(
      validateAutoReload({ ...base, packId: "texts_10000", thresholdUnits: max }).ok
    ).toBe(true);
  });

  it("rejects a non-integer threshold", () => {
    expect(validateAutoReload({ ...base, thresholdUnits: 100.5 })).toEqual({
      ok: false,
      error: "threshold_out_of_range"
    });
  });

  it("rejects a threshold the pack cannot clear", () => {
    // 500 texts cannot lift a balance above a 500-text threshold, so the
    // sweep would charge on every tick forever.
    expect(validateAutoReload({ ...base, thresholdUnits: 500 })).toEqual({
      ok: false,
      error: "threshold_not_below_pack"
    });
    expect(validateAutoReload({ ...base, thresholdUnits: 501 })).toEqual({
      ok: false,
      error: "threshold_not_below_pack"
    });
    // One below the grant size is the boundary that IS allowed.
    expect(validateAutoReload({ ...base, thresholdUnits: 499 }).ok).toBe(true);
  });

  it("rejects a monthly limit below one pack price", () => {
    const price = resolveAutoReloadPack("sms", "texts_500")!.priceCents;
    expect(validateAutoReload({ ...base, monthlyLimitCents: price - 1 })).toEqual({
      ok: false,
      error: "monthly_limit_below_pack_price"
    });
    // Exactly one pack per month is a real budget, so it is allowed.
    expect(validateAutoReload({ ...base, monthlyLimitCents: price }).ok).toBe(true);
  });

  it("rejects a malformed monthly limit", () => {
    for (const bad of [0, -100, 12.5, AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS + 1]) {
      expect(validateAutoReload({ ...base, monthlyLimitCents: bad })).toEqual({
        ok: false,
        error: "monthly_limit_out_of_range"
      });
    }
  });

  it("requires a monthly limit for chat only when enabled", () => {
    const chat = {
      category: "chat" as AutoReloadCategory,
      enabled: true,
      packId: "usd_5",
      thresholdUnits: 2_000_000,
      monthlyLimitCents: null as number | null
    };
    expect(validateAutoReload(chat)).toEqual({ ok: false, error: "monthly_limit_required" });
    // Disabled spends nothing, so the requirement does not apply.
    expect(validateAutoReload({ ...chat, enabled: false }).ok).toBe(true);
    expect(validateAutoReload({ ...chat, monthlyLimitCents: 2_000 }).ok).toBe(true);
  });

  it("does not require a monthly limit for voice or SMS", () => {
    expect(validateAutoReload({ ...base, enabled: true, monthlyLimitCents: null }).ok).toBe(true);
    expect(
      validateAutoReload({
        category: "voice",
        enabled: true,
        packId: "min_120",
        thresholdUnits: 900,
        monthlyLimitCents: null
      }).ok
    ).toBe(true);
  });

  it("validates even when the rule is off, so a poisoned config cannot be saved", () => {
    // Otherwise a tenant could save an unclearable threshold while disabled
    // and flip it on through a path that skips validation.
    expect(validateAutoReload({ ...base, enabled: false, thresholdUnits: 500 })).toEqual({
      ok: false,
      error: "threshold_not_below_pack"
    });
  });
});

describe("unit conversion", () => {
  it("round-trips each family", () => {
    expect(toDisplayUnits("voice", 900)).toBe(15);
    expect(fromDisplayUnits("voice", 15)).toBe(900);
    expect(toDisplayUnits("sms", 100)).toBe(100);
    expect(fromDisplayUnits("sms", 100)).toBe(100);
    expect(toDisplayUnits("chat", 2_000_000)).toBe(2);
    expect(fromDisplayUnits("chat", 2)).toBe(2_000_000);
  });

  it("rounds fractional input to whole canonical units", () => {
    expect(fromDisplayUnits("voice", 15.4)).toBe(924);
    expect(fromDisplayUnits("chat", 2.5)).toBe(2_500_000);
    expect(fromDisplayUnits("sms", 100.6)).toBe(101);
  });

  it("never rounds on the way OUT, so a no-edit save cannot move the trigger", () => {
    // The billing card seeds its inputs from these values and posts them back.
    // A rounding display direction rewrote a $2.50 threshold as $3.00 just
    // for opening the card and pressing Save.
    for (const units of [2_500_000, 1_250_000, 49_999_999]) {
      expect(fromDisplayUnits("chat", toDisplayUnits("chat", units))).toBe(units);
    }
    for (const units of [930, 305, 35_999]) {
      expect(fromDisplayUnits("voice", toDisplayUnits("voice", units))).toBe(units);
    }
    expect(toDisplayUnits("chat", 2_500_000)).toBe(2.5);
    expect(toDisplayUnits("voice", 930)).toBe(15.5);
  });
});

describe("isBelowThreshold", () => {
  it("is strict, so a balance exactly at the threshold does not fire", () => {
    expect(isBelowThreshold(99, 100)).toBe(true);
    expect(isBelowThreshold(100, 100)).toBe(false);
    expect(isBelowThreshold(101, 100)).toBe(false);
  });
});


describe("buildAttemptKey", () => {
  const businessId = "11111111-1111-4111-8111-111111111111";

  it("gives two ticks inside one cooldown window the same key", () => {
    const a = buildAttemptKey({
      businessId,
      category: "voice",
      cooldownMinutes: 30,
      now: new Date("2026-08-03T12:00:00Z")
    });
    const b = buildAttemptKey({
      businessId,
      category: "voice",
      cooldownMinutes: 30,
      now: new Date("2026-08-03T12:14:00Z")
    });
    expect(a).toBe(b);
  });

  it("gives the next window a different key", () => {
    const a = buildAttemptKey({
      businessId,
      category: "voice",
      cooldownMinutes: 30,
      now: new Date("2026-08-03T12:00:00Z")
    });
    const b = buildAttemptKey({
      businessId,
      category: "voice",
      cooldownMinutes: 30,
      now: new Date("2026-08-03T12:45:00Z")
    });
    expect(a).not.toBe(b);
  });

  it("separates families and tenants", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    const voice = buildAttemptKey({ businessId, category: "voice", cooldownMinutes: 30, now });
    const sms = buildAttemptKey({ businessId, category: "sms", cooldownMinutes: 30, now });
    const other = buildAttemptKey({
      businessId: "22222222-2222-4222-8222-222222222222",
      category: "voice",
      cooldownMinutes: 30,
      now
    });
    expect(new Set([voice, sms, other]).size).toBe(3);
  });

  it("never divides by zero on a degenerate cooldown", () => {
    const key = buildAttemptKey({
      businessId,
      category: "sms",
      cooldownMinutes: 0,
      now: new Date("2026-08-03T12:00:00Z")
    });
    expect(key).toMatch(/^11111111-1111-4111-8111-111111111111:sms:\d+$/);
  });
});

describe("classifyChargeFailure", () => {
  it("treats a bank challenge as its own kind, not a decline", () => {
    // Counting 3DS toward suspension would disable auto-reload for
    // well-behaved non-US cards after three ordinary challenges.
    expect(classifyChargeFailure({ code: "authentication_required", message: "3DS" })).toEqual({
      kind: "requires_action",
      code: "authentication_required",
      message: "3DS"
    });
  });

  it("separates recoverable declines from permanent ones", () => {
    expect(
      classifyChargeFailure({ code: "card_declined", decline_code: "insufficient_funds" }).kind
    ).toBe("soft_decline");
    expect(
      classifyChargeFailure({ code: "card_declined", decline_code: "generic_decline" }).kind
    ).toBe("soft_decline");
    expect(classifyChargeFailure({ code: "card_declined", decline_code: "do_not_honor" }).kind).toBe(
      "hard_decline"
    );
    expect(classifyChargeFailure({ code: "card_declined" }).kind).toBe("hard_decline");
    expect(classifyChargeFailure({ code: "expired_card" }).kind).toBe("hard_decline");
    expect(classifyChargeFailure({ code: "stolen_card" }).kind).toBe("hard_decline");
  });

  it("flags a missing payment method", () => {
    expect(classifyChargeFailure({ code: "payment_method_unactivated" }).kind).toBe(
      "no_payment_method"
    );
    expect(classifyChargeFailure({ code: "missing_payment_method" }).kind).toBe(
      "no_payment_method"
    );
  });

  it("falls back to soft for an unrecognised card error", () => {
    expect(classifyChargeFailure({ type: "StripeCardError", code: "weird_new_code" }).kind).toBe(
      "soft_decline"
    );
  });

  it("treats everything else as an API error", () => {
    expect(classifyChargeFailure(new Error("network down"))).toMatchObject({
      kind: "api_error",
      code: null,
      message: "network down"
    });
    expect(classifyChargeFailure(null)).toMatchObject({ kind: "api_error", code: null });
    expect(classifyChargeFailure({ code: 42, message: 7 })).toMatchObject({
      kind: "api_error",
      code: null
    });
    expect(classifyChargeFailure({ type: 5 }).kind).toBe("api_error");
  });
});

describe("platform kill switch", () => {
  it("is ON unless explicitly switched off", () => {
    // It shipped fail-closed so the feature could land dormant while the
    // money path was verified. Now unset means enabled, and only "0" stops it.
    delete process.env.USAGE_PACK_AUTO_RELOAD_ENABLED;
    expect(autoReloadPlatformEnabled()).toBe(true);
    process.env.USAGE_PACK_AUTO_RELOAD_ENABLED = "1";
    expect(autoReloadPlatformEnabled()).toBe(true);
    process.env.USAGE_PACK_AUTO_RELOAD_ENABLED = "0";
    expect(autoReloadPlatformEnabled()).toBe(false);
  });
});

describe("monthly spend ceilings", () => {
  it("defaults to the hard maximum when unset or malformed", () => {
    delete process.env.USAGE_PACK_AUTO_RELOAD_MAX_SPEND_CENTS_PER_PERIOD;
    expect(autoReloadPlatformMaxMonthlyCents()).toBe(AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS);
    for (const bad of ["abc", "0", "-5", "12.5"]) {
      process.env.USAGE_PACK_AUTO_RELOAD_MAX_SPEND_CENTS_PER_PERIOD = bad;
      expect(autoReloadPlatformMaxMonthlyCents()).toBe(AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS);
    }
  });

  it("honours a platform override and never exceeds the hard maximum", () => {
    process.env.USAGE_PACK_AUTO_RELOAD_MAX_SPEND_CENTS_PER_PERIOD = "10000";
    expect(autoReloadPlatformMaxMonthlyCents()).toBe(10_000);
    process.env.USAGE_PACK_AUTO_RELOAD_MAX_SPEND_CENTS_PER_PERIOD = "999999999";
    expect(autoReloadPlatformMaxMonthlyCents()).toBe(AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS);
  });

  it("clamps a tenant limit by the platform ceiling", () => {
    process.env.USAGE_PACK_AUTO_RELOAD_MAX_SPEND_CENTS_PER_PERIOD = "5000";
    // No tenant limit still means the platform ceiling applies.
    expect(effectiveMonthlyLimitCents(null)).toBe(5_000);
    expect(effectiveMonthlyLimitCents(2_000)).toBe(2_000);
    expect(effectiveMonthlyLimitCents(90_000)).toBe(5_000);
  });
});
