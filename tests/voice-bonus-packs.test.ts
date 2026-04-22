import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  VOICE_BONUS_PACK_IDS,
  getVoiceBonusPack,
  getVoiceBonusUsdPerMinute,
  listVoiceBonusPacks
} from "@/lib/billing/voice-bonus-packs";

const ENV_KEYS = [
  "VOICE_BONUS_USD_PER_MINUTE",
  "STRIPE_VOICE_BONUS_30MIN_PRICE_ID",
  "STRIPE_VOICE_BONUS_120MIN_PRICE_ID",
  "STRIPE_VOICE_BONUS_600MIN_PRICE_ID"
];

describe("lib/billing/voice-bonus-packs", () => {
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
    expect(VOICE_BONUS_PACK_IDS).toEqual(["min_30", "min_120", "min_600"]);
  });

  it("defaults the rate to $0.43/min when env is unset", () => {
    expect(getVoiceBonusUsdPerMinute()).toBe(0.43);
  });

  it("reads a valid custom rate from env", () => {
    process.env.VOICE_BONUS_USD_PER_MINUTE = "0.55";
    expect(getVoiceBonusUsdPerMinute()).toBe(0.55);
  });

  it("falls back to default when env value is not a positive finite number", () => {
    process.env.VOICE_BONUS_USD_PER_MINUTE = "not-a-number";
    expect(getVoiceBonusUsdPerMinute()).toBe(0.43);

    process.env.VOICE_BONUS_USD_PER_MINUTE = "0";
    expect(getVoiceBonusUsdPerMinute()).toBe(0.43);

    process.env.VOICE_BONUS_USD_PER_MINUTE = "-2";
    expect(getVoiceBonusUsdPerMinute()).toBe(0.43);
  });

  it("listVoiceBonusPacks returns empty when no price ids are configured", () => {
    expect(listVoiceBonusPacks()).toEqual([]);
  });

  it("lists only packs whose price id env var is configured and computes pricing from the rate", () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_30";
    process.env.STRIPE_VOICE_BONUS_600MIN_PRICE_ID = "price_600";

    const packs = listVoiceBonusPacks();
    expect(packs.map((p) => p.id)).toEqual(["min_30", "min_600"]);

    const pack30 = packs.find((p) => p.id === "min_30");
    expect(pack30).toMatchObject({
      id: "min_30",
      minutes: 30,
      seconds: 1800,
      priceCents: 1290,
      priceUsd: 12.9,
      priceId: "price_30",
      label: "30 minutes"
    });

    const pack600 = packs.find((p) => p.id === "min_600");
    expect(pack600).toMatchObject({
      id: "min_600",
      minutes: 600,
      seconds: 36000,
      priceCents: 25800,
      priceUsd: 258,
      priceId: "price_600"
    });
  });

  it("honors custom rate in pack pricing", () => {
    process.env.VOICE_BONUS_USD_PER_MINUTE = "0.50";
    process.env.STRIPE_VOICE_BONUS_120MIN_PRICE_ID = "price_120";

    const packs = listVoiceBonusPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      id: "min_120",
      minutes: 120,
      priceCents: 6000,
      priceUsd: 60
    });
  });

  it("getVoiceBonusPack returns null for unknown id", () => {
    expect(getVoiceBonusPack("min_99")).toBeNull();
  });

  it("getVoiceBonusPack returns null when the price id env var is not set", () => {
    expect(getVoiceBonusPack("min_30")).toBeNull();
  });

  it("getVoiceBonusPack returns the pack when configured", () => {
    process.env.STRIPE_VOICE_BONUS_120MIN_PRICE_ID = "price_120";
    const pack = getVoiceBonusPack("min_120");
    expect(pack).not.toBeNull();
    expect(pack?.priceId).toBe("price_120");
    expect(pack?.seconds).toBe(7200);
    expect(pack?.priceCents).toBe(5160);
  });
});
