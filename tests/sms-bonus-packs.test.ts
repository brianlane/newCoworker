import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  SMS_BONUS_PACK_IDS,
  getSmsBonusPack,
  getSmsBonusUsdPerText,
  listSmsBonusPacks
} from "@/lib/billing/sms-bonus-packs";

const ENV_KEYS = [
  "SMS_BONUS_USD_PER_TEXT",
  "STRIPE_SMS_BONUS_500_PRICE_ID",
  "STRIPE_SMS_BONUS_2000_PRICE_ID",
  "STRIPE_SMS_BONUS_10000_PRICE_ID",
  "STRIPE_SMS_BONUS_500_CENTS",
  "STRIPE_SMS_BONUS_2000_CENTS",
  "STRIPE_SMS_BONUS_10000_CENTS"
];

describe("lib/billing/sms-bonus-packs", () => {
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

  it("exposes the canonical pack id list", () => {
    expect(SMS_BONUS_PACK_IDS).toEqual(["texts_500", "texts_2000", "texts_10000"]);
  });

  it("defaults the rate to $0.02/text when env is unset", () => {
    expect(getSmsBonusUsdPerText()).toBe(0.02);
  });

  it("reads a valid custom rate from env", () => {
    process.env.SMS_BONUS_USD_PER_TEXT = "0.015";
    expect(getSmsBonusUsdPerText()).toBe(0.015);
  });

  it("falls back to default when env value is not a positive finite number", () => {
    process.env.SMS_BONUS_USD_PER_TEXT = "not-a-number";
    expect(getSmsBonusUsdPerText()).toBe(0.02);

    process.env.SMS_BONUS_USD_PER_TEXT = "0";
    expect(getSmsBonusUsdPerText()).toBe(0.02);

    process.env.SMS_BONUS_USD_PER_TEXT = "-1";
    expect(getSmsBonusUsdPerText()).toBe(0.02);
  });

  it("listSmsBonusPacks returns empty when no price ids are configured", () => {
    expect(listSmsBonusPacks()).toEqual([]);
  });

  it("lists only packs whose price id env var is configured and computes pricing from the rate", () => {
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_500";
    process.env.STRIPE_SMS_BONUS_10000_PRICE_ID = "price_10000";

    const packs = listSmsBonusPacks();
    expect(packs.map((p) => p.id)).toEqual(["texts_500", "texts_10000"]);

    const pack500 = packs.find((p) => p.id === "texts_500");
    expect(pack500).toMatchObject({
      id: "texts_500",
      texts: 500,
      priceCents: 1000,
      priceUsd: 10,
      priceId: "price_500",
      label: "500 texts"
    });
    expect(pack500?.effectiveUsdPerText).toBeCloseTo(0.02, 5);

    const pack10k = packs.find((p) => p.id === "texts_10000");
    expect(pack10k).toMatchObject({
      id: "texts_10000",
      texts: 10000,
      priceCents: 20000,
      priceUsd: 200,
      priceId: "price_10000"
    });
  });

  it("honors custom rate in pack pricing", () => {
    process.env.SMS_BONUS_USD_PER_TEXT = "0.01";
    process.env.STRIPE_SMS_BONUS_2000_PRICE_ID = "price_2000";

    const packs = listSmsBonusPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      id: "texts_2000",
      texts: 2000,
      priceCents: 2000,
      priceUsd: 20
    });
  });

  it("per-pack cents override beats the $/text rate", () => {
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_500";
    process.env.STRIPE_SMS_BONUS_500_CENTS = "899";

    const [pack] = listSmsBonusPacks();
    expect(pack.priceCents).toBe(899);
    expect(pack.priceUsd).toBeCloseTo(8.99, 5);
    expect(pack.effectiveUsdPerText).toBeCloseTo(8.99 / 500, 6);
  });

  it("ignores malformed cents override and falls back to the rate", () => {
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_500";

    process.env.STRIPE_SMS_BONUS_500_CENTS = "not-a-number";
    expect(listSmsBonusPacks()[0].priceCents).toBe(1000);

    process.env.STRIPE_SMS_BONUS_500_CENTS = "-5";
    expect(listSmsBonusPacks()[0].priceCents).toBe(1000);

    process.env.STRIPE_SMS_BONUS_500_CENTS = "12.5";
    expect(listSmsBonusPacks()[0].priceCents).toBe(1000);
  });

  it("getSmsBonusPack returns null for unknown id", () => {
    expect(getSmsBonusPack("texts_99")).toBeNull();
  });

  it("getSmsBonusPack returns null when the price id env var is not set", () => {
    expect(getSmsBonusPack("texts_500")).toBeNull();
  });

  it("getSmsBonusPack returns the pack when configured", () => {
    process.env.STRIPE_SMS_BONUS_2000_PRICE_ID = "price_2000";
    const pack = getSmsBonusPack("texts_2000");
    expect(pack).not.toBeNull();
    expect(pack?.priceId).toBe("price_2000");
    expect(pack?.texts).toBe(2000);
    expect(pack?.priceCents).toBe(4000);
    expect(pack?.description).toContain("2,000");
  });

  it("getSmsBonusPack honors per-pack cents override", () => {
    process.env.STRIPE_SMS_BONUS_10000_PRICE_ID = "price_10000";
    process.env.STRIPE_SMS_BONUS_10000_CENTS = "15000";
    const pack = getSmsBonusPack("texts_10000");
    expect(pack?.priceCents).toBe(15000);
    expect(pack?.priceUsd).toBe(150);
  });
});
