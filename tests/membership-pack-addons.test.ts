import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  decodeMembershipPackMeta,
  discountedPackCents,
  encodeMembershipPackMeta,
  grantAmountForPeriod,
  listMembershipPackAddonOptions,
  membershipPackAddOnsDueTodayCents,
  membershipPackDiscountPercent,
  parseMembershipPackAddonMetadata,
  resolveMembershipPackAddons,
  sessionHasMembershipPackAddons,
  membershipPackAddonsForRow,
  membershipPackSelectionFromRow,
  MEMBERSHIP_PACK_LINE_NAME_PREFIXES
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

  it("encodes and decodes compact pack metadata", () => {
    const encoded = encodeMembershipPackMeta([
      { packId: "min_30", quantity: 3, unitSize: 1800 },
      { packId: "min_120", quantity: 1, unitSize: 7200 }
    ]);
    expect(encoded).toBe("min_30:3:1800,min_120:1:7200");
    expect(decodeMembershipPackMeta(encoded)).toEqual([
      { packId: "min_30", quantity: 3, unitSize: 1800 },
      { packId: "min_120", quantity: 1, unitSize: 7200 }
    ]);
    expect(decodeMembershipPackMeta("bad")).toEqual([]);
  });

  it("multiplies grant amount by quantity and commitment months", () => {
    expect(grantAmountForPeriod(1800, 3, "monthly")).toBe(5400);
    expect(grantAmountForPeriod(1800, 3, "annual")).toBe(5400 * 12);
    expect(grantAmountForPeriod(1800, 1, "biennial")).toBe(1800 * 24);
  });

  it("resolves quantities into recurring term lines and metadata", () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1399";
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms_500";
    process.env.STRIPE_SMS_BONUS_500_CENTS = "1000";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_chat_5";
    process.env.STRIPE_CHAT_CREDIT_5USD_CENTS = "500";

    const resolved = resolveMembershipPackAddons(
      {
        voicePacks: [{ packId: "min_30", quantity: 3 }],
        smsPacks: [{ packId: "texts_500", quantity: 1 }],
        chatPacks: [{ packId: "usd_5", quantity: 2 }]
      },
      "biennial"
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.lines).toHaveLength(3);
    expect(resolved.lines[0]).toMatchObject({
      category: "voice",
      packId: "min_30",
      quantity: 3,
      listPriceCents: 1399,
      discountedMonthlyCents: 1119,
      unitAmountCents: 1119 * 24,
      voiceSeconds: 1800
    });
    expect(resolved.totalCents).toBe(1119 * 24 * 3 + 800 * 24 * 1 + 400 * 24 * 2);
    expect(resolved.metadata).toEqual({
      addonVoice: "min_30:3:1800",
      addonSms: "texts_500:1:500",
      addonChat: "usd_5:2:5000000"
    });
  });

  it("keeps every line name on its category's carve-out prefix (lockstep)", () => {
    // The refund executor identifies pack lines on the refunded invoice by
    // MEMBERSHIP_PACK_LINE_NAME_PREFIXES; a line built with any other name
    // would silently refund pack dollars.
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1399";
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms_500";
    process.env.STRIPE_SMS_BONUS_500_CENTS = "1000";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_chat_5";
    process.env.STRIPE_CHAT_CREDIT_5USD_CENTS = "500";

    expect(Object.keys(MEMBERSHIP_PACK_LINE_NAME_PREFIXES).sort()).toEqual([
      "chat",
      "sms",
      "voice"
    ]);

    const resolved = resolveMembershipPackAddons(
      {
        voicePacks: [{ packId: "min_30", quantity: 1 }],
        smsPacks: [{ packId: "texts_500", quantity: 1 }],
        chatPacks: [{ packId: "usd_5", quantity: 1 }]
      },
      "monthly"
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.lines).toHaveLength(3);
    for (const line of resolved.lines) {
      expect(line.name.startsWith(MEMBERSHIP_PACK_LINE_NAME_PREFIXES[line.category])).toBe(true);
    }
  });

  it("collapses duplicate SKUs and rejects bad quantities", () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    process.env.STRIPE_VOICE_BONUS_30MIN_CENTS = "1000";

    const collapsed = resolveMembershipPackAddons(
      {
        voicePacks: [
          { packId: "min_30", quantity: 2 },
          { packId: "min_30", quantity: 1 }
        ]
      },
      "monthly"
    );
    expect(collapsed.ok).toBe(true);
    if (!collapsed.ok) return;
    expect(collapsed.lines[0]?.quantity).toBe(3);

    const badQty = resolveMembershipPackAddons(
      { voicePacks: [{ packId: "min_30", quantity: 0 }] },
      "monthly"
    );
    expect(badQty.ok).toBe(false);

    const tooMany = resolveMembershipPackAddons(
      { voicePacks: [{ packId: "min_30", quantity: 21 }] },
      "monthly"
    );
    expect(tooMany.ok).toBe(false);
  });

  it("rejects unknown or unconfigured pack ids", () => {
    const unknown = resolveMembershipPackAddons(
      { voicePacks: [{ packId: "min_30", quantity: 1 }] },
      "monthly"
    );
    expect(unknown).toEqual({
      ok: false,
      error: "Unknown or unavailable voice pack: min_30"
    });

    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    const badSms = resolveMembershipPackAddons(
      {
        voicePacks: [{ packId: "min_30", quantity: 1 }],
        smsPacks: [{ packId: "texts_nope", quantity: 1 }]
      },
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
    const bad = resolveMembershipPackAddons(
      { chatPacks: [{ packId: "usd_nope", quantity: 1 }] },
      "monthly"
    );
    expect(bad).toEqual({
      ok: false,
      error: "Unknown or unavailable chat credit pack: usd_nope"
    });
  });

  it("detects recurring membership addon metadata only", () => {
    expect(sessionHasMembershipPackAddons(undefined)).toBe(false);
    expect(sessionHasMembershipPackAddons({})).toBe(false);
    expect(sessionHasMembershipPackAddons({ addonVoice: "min_30:1:1800" })).toBe(true);
    // Legacy one-time keys must not count as recurring add-ons.
    expect(sessionHasMembershipPackAddons({ addonVoicePackId: "min_30" })).toBe(false);
  });

  it("ignores legacy single-pack metadata when parsing grants", () => {
    const parsed = parseMembershipPackAddonMetadata({
      addonVoicePackId: "min_30",
      addonVoiceSeconds: "1800"
    });
    expect(parsed.voice).toEqual([]);
  });

  it("computes due-today with term months and quantity", () => {
    const options = [
      { category: "voice" as const, id: "min_30", label: "30", listPriceCents: 1000 }
    ];
    expect(
      membershipPackAddOnsDueTodayCents(
        { voicePacks: [{ packId: "min_30", quantity: 2 }] },
        options,
        "annual"
      )
    ).toBe(900 * 12 * 2);
    expect(
      membershipPackAddOnsDueTodayCents(
        { voicePacks: [{ packId: "missing", quantity: 1 }, { packId: "min_30", quantity: 0.5 as number }] },
        options,
        "monthly"
      )
    ).toBe(0);
  });

  it("rejects empty pack ids and collapsed qty over the max", () => {
    process.env.STRIPE_VOICE_BONUS_30MIN_PRICE_ID = "price_voice_30";
    process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_sms";
    process.env.STRIPE_CHAT_CREDIT_5USD_PRICE_ID = "price_chat";
    expect(
      resolveMembershipPackAddons({ voicePacks: [{ packId: "  ", quantity: 1 }] }, "monthly").ok
    ).toBe(false);
    expect(
      resolveMembershipPackAddons({ smsPacks: [{ packId: "texts_500", quantity: 0 }] }, "monthly")
    ).toMatchObject({ ok: false });
    expect(
      resolveMembershipPackAddons({ chatPacks: [{ packId: "usd_5", quantity: 21 }] }, "monthly")
    ).toMatchObject({ ok: false });
    expect(
      resolveMembershipPackAddons(
        { voicePacks: [{ packId: 12 as unknown as string, quantity: 1 }] },
        "monthly"
      ).ok
    ).toBe(false);
    expect(
      resolveMembershipPackAddons(
        {
          voicePacks: [
            { packId: "min_30", quantity: 12 },
            { packId: "min_30", quantity: 12 }
          ]
        },
        "monthly"
      )
    ).toEqual({
      ok: false,
      error: "Pack quantity for min_30 exceeds max 20"
    });
  });

  it("parses null metadata and ignores legacy sms/chat keys", () => {
    expect(parseMembershipPackAddonMetadata(null)).toEqual({
      voice: [],
      sms: [],
      chat: []
    });
    expect(
      parseMembershipPackAddonMetadata({
        addonSmsPackId: "texts_500",
        addonSmsTexts: "500",
        addonChatPackId: "usd_5",
        addonChatMicros: "5000000"
      })
    ).toEqual({ voice: [], sms: [], chat: [] });
    expect(
      parseMembershipPackAddonMetadata({
        addonSms: "texts_500:1:500",
        addonChat: "usd_5:1:5000000"
      })
    ).toEqual({
      voice: [],
      sms: [{ packId: "texts_500", quantity: 1, unitSize: 500 }],
      chat: [{ packId: "usd_5", quantity: 1, unitSize: 5_000_000 }]
    });
  });

  it("skips malformed decode segments", () => {
    expect(decodeMembershipPackMeta("min_30:3:1800,,bad:x:y,min_30:0:1800,min_30:1:0,:1:1800")).toEqual([
      { packId: "min_30", quantity: 3, unitSize: 1800 }
    ]);
  });
});

/**
 * The packs a tenant carries live only in Stripe subscription metadata, so
 * nothing server-rendered could see them and the change-plan selector started
 * empty every time. Change-plan rebuilds the subscription from the selector's
 * lines alone, so a tenant switching period without touching the steppers
 * silently lost their packs from the next invoice.
 */
describe("membership pack add-on mirroring", () => {
  it("keeps only the three pack keys, so one encoding is stored not two", () => {
    expect(
      membershipPackAddonsForRow({
        addonVoice: "min_30:2:1800",
        addonSms: "texts_500:1:500",
        unrelated: "keep out",
        businessId: "biz-1"
      })
    ).toEqual({ addonVoice: "min_30:2:1800", addonSms: "texts_500:1:500" });
  });

  it("is null when the subscription carries no packs", () => {
    expect(membershipPackAddonsForRow({ businessId: "biz-1" })).toBeNull();
    expect(membershipPackAddonsForRow(null)).toBeNull();
  });

  it("round-trips back into a selector selection", () => {
    const stored = membershipPackAddonsForRow({
      addonVoice: "min_30:2:1800",
      addonChat: "usd_5:3:5000000"
    });
    expect(membershipPackSelectionFromRow(stored)).toEqual({
      voicePacks: [{ packId: "min_30", quantity: 2 }],
      smsPacks: [],
      chatPacks: [{ packId: "usd_5", quantity: 3 }]
    });
  });

  it("reads an empty selection from a row that has none", () => {
    expect(membershipPackSelectionFromRow(null)).toEqual({
      voicePacks: [],
      smsPacks: [],
      chatPacks: []
    });
  });

  it("ignores a stored value that is not an object", () => {
    expect(membershipPackSelectionFromRow("nonsense")).toEqual({
      voicePacks: [],
      smsPacks: [],
      chatPacks: []
    });
  });
});

/**
 * #1023 hardened the standalone top-up parsers with hard unit ceilings so "a
 * forged/corrupt metadata value can never mint an unbounded cap raise", and
 * they REJECT above the ceiling rather than clamp. #1026's recurring decoder
 * accepted any positive integer, so the membership path lost that defense:
 * unitSize x qty(<=20) x months(<=24) multiplied an unbounded number.
 */
describe("parseMembershipPackAddonMetadata, per-kind unit ceilings", () => {
  it("drops a voice entry whose unit size exceeds a year of seconds", () => {
    const parsed = parseMembershipPackAddonMetadata({
      addonVoice: `min_30:1:${60 * 60 * 24 * 365 + 1}`
    });
    expect(parsed.voice).toEqual([]);
  });

  it("drops an sms entry above one million texts", () => {
    expect(
      parseMembershipPackAddonMetadata({ addonSms: "texts_500:1:1000001" }).sms
    ).toEqual([]);
  });

  it("drops a chat entry above one billion micros", () => {
    expect(
      parseMembershipPackAddonMetadata({ addonChat: "usd_5:1:1000000001" }).chat
    ).toEqual([]);
  });

  it("keeps entries at the ceiling and drops only the oversized sibling", () => {
    const parsed = parseMembershipPackAddonMetadata({
      addonVoice: `min_30:1:1800,min_600:1:${60 * 60 * 24 * 365 + 1}`
    });
    expect(parsed.voice).toEqual([{ packId: "min_30", quantity: 1, unitSize: 1800 }]);
  });
});
