import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  discountedPackCents,
  listMembershipPackAddonOptions,
  membershipPackDiscountPercent,
  resolveMembershipPackAddons,
  sessionHasMembershipPackAddons
} from "@/lib/billing/membership-pack-addons";

const ENV_KEYS = [
  "VOICE_BONUS_USD_PER_MINUTE",
  "STRIPE_VOICE_BONUS_30MIN_PRICE_ID",
  "STRIPE_VOICE_BONUS_120MIN_PRICE_ID",
  "STRIPE_VOICE_BONUS_600MIN_PRICE_ID",
  "STRIPE_VOICE_BONUS_30MIN_CENTS",
  "SMS_BONUS_USD_PER_TEXT",
  "STRIPE_SMS_BONUS_500_PRICE_ID",
  "STRIPE_SMS_BONUS_500_CENTS",
  "STRIPE_CHAT_CREDIT_5USD_PRICE_ID",
  "STRIPE_CHAT_CREDIT_5USD_CENTS"
];

describe("lib/billing/membership-pack-addons", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("maps term discounts to 5 / 10 / 20 percent", () => {
    expect(membershipPackDiscountPercent("monthly")).toBe(5);
    expect(membershipPackDiscountPercent("annual")).toBe(10);
    expect(membershipPackDiscountPercent("biennial")).toBe(20);
  });

  it("rounds discounted cents with integer math", () => {
    expect(discountedPackCents(1000, "monthly")).toBe(950);
    expect(discountedPackCents(1399, "annual")).toBe(1259);
    expect(discountedPackCents(1399, "biennial")).toBe(1119);
    expect(discountedPackCents(0, "monthly")).toBe(0);
  });

  it("resolves configured packs into discounted lines and metadata", () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1399";
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms_500";
    process.env.STRIPE_SMS_BONUS_500_CENTS = "1000";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_chat_5";
    process.env.STRIPE_CHAT_CREDIT_5USD_CENTS = "500";

    const resolved = resolveMembershipPackAddons(
      { voicePackId: "min_30", smsPackId: "texts_500", chatPackId: "usd_5" },
      "biennial"
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.lines).toHaveLength(3);
    expect(resolved.lines[0]).toMatchObject({
      category: "voice",
      packId: "min_30",
      listPriceCents: 1399,
      unitAmountCents: 1119,
      voiceSeconds: 1800
    });
    expect(resolved.lines[1]).toMatchObject({
      category: "sms",
      unitAmountCents: 800,
      smsTexts: 500
    });
    expect(resolved.lines[2]).toMatchObject({
      category: "chat",
      unitAmountCents: 400,
      creditMicros: 5_000_000
    });
    expect(resolved.totalCents).toBe(1119 + 800 + 400);
    expect(resolved.metadata).toMatchObject({
      addonVoicePackId: "min_30",
      addonVoiceSeconds: "1800",
      addonVoiceCents: "1119",
      addonSmsPackId: "texts_500",
      addonSmsTexts: "500",
      addonSmsCents: "800",
      addonChatPackId: "usd_5",
      addonChatMicros: "5000000",
      addonChatCents: "400"
    });
  });

  it("rejects unknown or unconfigured pack ids", () => {
    const unknown = resolveMembershipPackAddons({ voicePackId: "min_30" }, "monthly");
    expect(unknown).toEqual({
      ok: false,
      error: "Unknown or unavailable voice pack: min_30"
    });

    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    const badSms = resolveMembershipPackAddons(
      { voicePackId: "min_30", smsPackId: "texts_nope" },
      "monthly"
    );
    expect(badSms.ok).toBe(false);
  });

  it("lists only configured options for the picker", () => {
    expect(listMembershipPackAddonOptions()).toEqual([]);
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_v";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1000";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_c";
    const options = listMembershipPackAddonOptions();
    expect(options.map((o) => o.id)).toEqual(["min_30", "usd_5"]);
  });

  it("resolves an empty selection to zero lines", () => {
    const resolved = resolveMembershipPackAddons({}, "monthly");
    expect(resolved).toEqual({ ok: true, lines: [], totalCents: 0, metadata: {} });
  });

  it("lists sms options when configured", () => {
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms";
    process.env.STRIPE_SMS_BONUS_500_CENTS = "1000";
    const options = listMembershipPackAddonOptions();
    expect(options.some((o) => o.category === "sms" && o.id === "texts_500")).toBe(true);
  });

  it("rejects an unknown chat pack id", () => {
    const bad = resolveMembershipPackAddons({ chatPackId: "usd_nope" }, "monthly");
    expect(bad).toEqual({
      ok: false,
      error: "Unknown or unavailable chat credit pack: usd_nope"
    });
  });

  it("detects membership addon metadata", () => {
    expect(sessionHasMembershipPackAddons(undefined)).toBe(false);
    expect(sessionHasMembershipPackAddons({})).toBe(false);
    expect(sessionHasMembershipPackAddons({ addonVoicePackId: "min_30" })).toBe(true);
  });
});
