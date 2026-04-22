import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_BONUS_PACK_IDS,
  deriveVoiceBonusUsdPerMinute,
  getVoiceBonusPack,
  getVoiceBonusUsdPerMinute,
  listVoiceBonusPacks,
  resolveVoiceBonusPacks
} from "@/lib/billing/voice-bonus-packs";
import type { VoiceBonusPack } from "@/lib/billing/voice-bonus-packs";

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

  describe("resolveVoiceBonusPacks (Stripe-authoritative amounts)", () => {
    beforeEach(() => {
      process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_30";
      process.env.STRIPE_VOICE_BONUS_120MIN_PRICE_ID = "price_120";
      process.env.STRIPE_VOICE_BONUS_600MIN_PRICE_ID = "price_600";
    });

    it("overrides env-derived amounts with the Stripe unit_amount", async () => {
      // Regression: UI used to show VOICE_BONUS_USD_PER_MINUTE * minutes
      // but the real charge came from the Stripe Price object, so they
      // could silently diverge. Now: Stripe's unit_amount wins.
      const resolver = vi.fn().mockImplementation((id: string) => {
        const map: Record<string, number> = {
          price_30: 1500,   // $15.00 on Stripe (env says $12.90)
          price_120: 5900,  // $59.00
          price_600: 27000  // $270.00
        };
        return Promise.resolve({ unit_amount: map[id] ?? null });
      });
      const packs = await resolveVoiceBonusPacks(resolver);
      expect(resolver).toHaveBeenCalledTimes(3);
      expect(packs.map((p) => [p.id, p.priceCents, p.priceUsd])).toEqual([
        ["min_30", 1500, 15],
        ["min_120", 5900, 59],
        ["min_600", 27000, 270]
      ]);
    });

    it("falls back to env amount when Stripe returns null unit_amount (metered / tiered Price)", async () => {
      const resolver = vi.fn().mockResolvedValue({ unit_amount: null });
      const packs = await resolveVoiceBonusPacks(resolver);
      // env default rate 0.43 => 30min = 1290 cents
      expect(packs.find((p) => p.id === "min_30")?.priceCents).toBe(1290);
    });

    it("falls back to env amount when Stripe returns a non-positive unit_amount", async () => {
      const resolver = vi.fn().mockImplementation((id: string) => {
        if (id === "price_30") return Promise.resolve({ unit_amount: 0 });
        if (id === "price_120") return Promise.resolve({ unit_amount: -5 });
        return Promise.resolve({ unit_amount: Number.NaN });
      });
      const packs = await resolveVoiceBonusPacks(resolver);
      // All three must keep env-derived amounts.
      expect(packs.find((p) => p.id === "min_30")?.priceCents).toBe(1290);
      expect(packs.find((p) => p.id === "min_120")?.priceCents).toBe(5160);
      expect(packs.find((p) => p.id === "min_600")?.priceCents).toBe(25800);
    });

    it("falls back to env amount per-pack when the Stripe call throws (Error)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const resolver = vi.fn().mockImplementation((id: string) => {
        if (id === "price_120") return Promise.reject(new Error("stripe down"));
        return Promise.resolve({ unit_amount: 1 });
      });
      const packs = await resolveVoiceBonusPacks(resolver);
      // price_120 fell through to env-derived $0.43*120 = $51.60.
      expect(packs.find((p) => p.id === "min_120")?.priceCents).toBe(5160);
      // The other two picked up the Stripe amount (1 cent here — cheap test).
      expect(packs.find((p) => p.id === "min_30")?.priceCents).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("price_120"),
        "stripe down"
      );
      warn.mockRestore();
    });

    it("falls back to env amount when Stripe rejects with a non-Error value", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const resolver = vi.fn().mockRejectedValue("weird-string-error");
      const packs = await resolveVoiceBonusPacks(resolver);
      expect(packs.find((p) => p.id === "min_30")?.priceCents).toBe(1290);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("price_30"),
        "weird-string-error"
      );
      warn.mockRestore();
    });

    it("returns empty array without calling Stripe when no packs are configured", async () => {
      for (const k of [
        "STRIPE_VOICE_BONUS_30MIN_PRICE_ID",
        "STRIPE_VOICE_BONUS_120MIN_PRICE_ID",
        "STRIPE_VOICE_BONUS_600MIN_PRICE_ID"
      ]) {
        delete process.env[k];
      }
      const resolver = vi.fn();
      const packs = await resolveVoiceBonusPacks(resolver);
      expect(packs).toEqual([]);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  describe("deriveVoiceBonusUsdPerMinute", () => {
    it("derives the rate from the first pack so UI matches Stripe exactly", () => {
      const packs: VoiceBonusPack[] = [
        {
          id: "min_30",
          minutes: 30,
          seconds: 1800,
          priceCents: 1500,
          priceUsd: 15,
          priceId: "price_30",
          label: "30 minutes",
          description: ""
        }
      ];
      expect(deriveVoiceBonusUsdPerMinute(packs)).toBeCloseTo(0.5, 6);
    });

    it("falls back to the env rate when packs are empty", () => {
      process.env.VOICE_BONUS_USD_PER_MINUTE = "0.61";
      expect(deriveVoiceBonusUsdPerMinute([])).toBe(0.61);
    });

    it("falls back to the env rate when the first pack has no minutes", () => {
      const packs: VoiceBonusPack[] = [
        {
          id: "min_30",
          minutes: 0,
          seconds: 0,
          priceCents: 1500,
          priceUsd: 15,
          priceId: "price_30",
          label: "0 minutes",
          description: ""
        }
      ];
      expect(deriveVoiceBonusUsdPerMinute(packs)).toBe(0.43);
    });
  });
});
