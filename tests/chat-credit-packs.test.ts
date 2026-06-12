import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  CHAT_CREDIT_PACK_IDS,
  getChatCreditPack,
  listChatCreditPacks
} from "@/lib/billing/chat-credit-packs";

const ENV_KEYS = [
  "STRIPE_CHAT_CREDIT_5USD_PRICE_ID",
  "STRIPE_CHAT_CREDIT_10USD_PRICE_ID",
  "STRIPE_CHAT_CREDIT_25USD_PRICE_ID",
  "STRIPE_CHAT_CREDIT_5USD_CENTS",
  "STRIPE_CHAT_CREDIT_10USD_CENTS",
  "STRIPE_CHAT_CREDIT_25USD_CENTS"
];

describe("lib/billing/chat-credit-packs", () => {
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
    expect(CHAT_CREDIT_PACK_IDS).toEqual(["usd_5", "usd_10", "usd_25"]);
  });

  it("listChatCreditPacks returns empty when no price ids are configured", () => {
    expect(listChatCreditPacks()).toEqual([]);
  });

  it("lists only packs whose price id env var is configured, priced at face value by default", () => {
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_c5";
    process.env.STRIPE_CHAT_CREDIT_25USD_PRICE_ID = "price_c25";

    const packs = listChatCreditPacks();
    expect(packs.map((p) => p.id)).toEqual(["usd_5", "usd_25"]);

    const p5 = packs.find((p) => p.id === "usd_5");
    expect(p5).toMatchObject({
      id: "usd_5",
      creditUsd: 5,
      creditMicros: 5_000_000,
      priceCents: 500,
      priceUsd: 5,
      priceId: "price_c5",
      label: "$5 AI credit"
    });

    const p25 = packs.find((p) => p.id === "usd_25");
    expect(p25).toMatchObject({
      id: "usd_25",
      creditUsd: 25,
      creditMicros: 25_000_000,
      priceCents: 2500,
      priceUsd: 25
    });
  });

  it("per-pack cents override beats face value", () => {
    process.env.STRIPE_CHAT_CREDIT_10USD_PRICE_ID = "price_c10";
    process.env.STRIPE_CHAT_CREDIT_10USD_CENTS = "899";

    const [pack] = listChatCreditPacks();
    expect(pack.priceCents).toBe(899);
    expect(pack.priceUsd).toBeCloseTo(8.99, 5);
    // The granted credit stays at face value regardless of price override.
    expect(pack.creditMicros).toBe(10_000_000);
  });

  it("ignores malformed cents override and falls back to face value", () => {
    process.env.STRIPE_CHAT_CREDIT_10USD_PRICE_ID = "price_c10";

    process.env.STRIPE_CHAT_CREDIT_10USD_CENTS = "not-a-number";
    expect(listChatCreditPacks()[0].priceCents).toBe(1000);

    process.env.STRIPE_CHAT_CREDIT_10USD_CENTS = "-5";
    expect(listChatCreditPacks()[0].priceCents).toBe(1000);

    process.env.STRIPE_CHAT_CREDIT_10USD_CENTS = "9.5";
    expect(listChatCreditPacks()[0].priceCents).toBe(1000);
  });

  it("getChatCreditPack returns null for unknown id", () => {
    expect(getChatCreditPack("usd_99")).toBeNull();
  });

  it("getChatCreditPack returns null when the price id env var is not set", () => {
    expect(getChatCreditPack("usd_5")).toBeNull();
  });

  it("getChatCreditPack returns the pack when configured", () => {
    process.env.STRIPE_CHAT_CREDIT_25USD_PRICE_ID = "price_c25";
    const pack = getChatCreditPack("usd_25");
    expect(pack).not.toBeNull();
    expect(pack?.priceId).toBe("price_c25");
    expect(pack?.creditMicros).toBe(25_000_000);
    expect(pack?.description).toContain("$25");
  });
});
