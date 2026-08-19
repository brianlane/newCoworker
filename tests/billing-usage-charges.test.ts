import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  applyBonusFundedUsageOffsets,
  computeBillableUsageCents,
  loadBillableUsageCarveOutCents,
  loadBillableUsageSince,
  loadBonusFundedUsageOffsets,
  resolveUsageCarveOutWindow
} from "@/lib/billing/usage-charges";
import { ENTERPRISE_UNIT_COSTS } from "@/lib/plans/enterprise-pricing";
import { chatSpendBaseCapMicrosForTier } from "@/lib/db/chat-usage";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

describe("computeBillableUsageCents", () => {
  it("prices SMS both ways, Telnyx-only voice, and AI spend with a single final round", () => {
    const cents = computeBillableUsageCents({
      smsSent: 100,
      smsReceived: 40,
      voiceSeconds: 50 * 60,
      aiSpendMicros: 1_234_999 // $1.234999
    });
    expect(cents).toBe(
      Math.round(
        100 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
          40 * ENTERPRISE_UNIT_COSTS.smsInboundCentsPerMessage +
          // Telnyx-only on purpose: the Gemini Live component of a call is
          // metered into owner_chat_model_spend and arrives via aiSpendMicros,
          // the all-in rate would double-charge it.
          50 * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute +
          123.4999
      )
    );
  });

  it("returns 0 for a tenant with no usage", () => {
    expect(
      computeBillableUsageCents({ smsSent: 0, smsReceived: 0, voiceSeconds: 0, aiSpendMicros: 0 })
    ).toBe(0);
  });
});

describe("resolveUsageCarveOutWindow", () => {
  const NOW = new Date("2026-07-10T12:00:00Z");

  it("prefers the cached Stripe period start (AI spend filtered from the same instant)", () => {
    expect(
      resolveUsageCarveOutWindow({
        stripeCurrentPeriodStart: "2026-07-01T00:00:00Z",
        profile: { first_paid_at: "2026-06-01T00:00:00Z", refund_used_at: null },
        now: NOW
      })
    ).toEqual({
      ok: true,
      window: {
        sinceIso: "2026-07-01T00:00:00Z",
        aiSpendSinceIso: "2026-07-01T00:00:00Z"
      }
    });
  });

  it("falls back to first_paid_at (lifetime AI spend) while the 30-day window is still open", () => {
    for (const stripeCurrentPeriodStart of [null, "not-a-date"]) {
      expect(
        resolveUsageCarveOutWindow({
          stripeCurrentPeriodStart,
          profile: { first_paid_at: "2026-07-05T00:00:00Z", refund_used_at: null },
          now: NOW
        })
      ).toEqual({
        ok: true,
        window: { sinceIso: "2026-07-05T00:00:00Z", aiSpendSinceIso: null }
      });
    }
  });

  it("fails closed with no period cache once the refund window is closed or used", () => {
    // Closed window: first paid > 30 days before now. Anchoring on
    // first_paid_at here would withhold months of prior-period usage from a
    // one-month refund (admin force-refund path).
    expect(
      resolveUsageCarveOutWindow({
        stripeCurrentPeriodStart: null,
        profile: { first_paid_at: "2026-01-01T00:00:00Z", refund_used_at: null },
        now: NOW
      })
    ).toEqual({ ok: false, reason: "usage_window_unknown" });
    expect(
      resolveUsageCarveOutWindow({
        stripeCurrentPeriodStart: null,
        profile: { first_paid_at: "2026-07-05T00:00:00Z", refund_used_at: "2026-07-06T00:00:00Z" },
        now: NOW
      })
    ).toEqual({ ok: false, reason: "usage_window_unknown" });
  });

  it("fails closed with no period cache and no profile", () => {
    expect(
      resolveUsageCarveOutWindow({ stripeCurrentPeriodStart: null, profile: null, now: NOW })
    ).toEqual({ ok: false, reason: "usage_window_unknown" });
  });

  it("defaults `now` to the current time", () => {
    expect(
      resolveUsageCarveOutWindow({
        stripeCurrentPeriodStart: null,
        profile: { first_paid_at: new Date().toISOString(), refund_used_at: null }
      }).ok
    ).toBe(true);
  });
});

/**
 * Fake client where each table returns configurable pages: `pages[table]`
 * is an array of page results (rows arrays) served in order by `.range()`
 * calls; `errors[table]` short-circuits the read with an error. Count reads
 * (the inbound-SMS HEAD query) await the builder chain itself, so the chain
 * is thenable and resolves `{ count: counts[table] ?? null, error }`.
 * Single-row reads resolve `.maybeSingle()` from `singles[table]`.
 *
 * Pages are served per TABLE across queries: when a composed call reads the
 * same table twice (the wrapper reads owner_chat_model_spend for the total
 * AND for the offset), stack that table's pages in read order and end each
 * query with a short page.
 */
function makeUsageClient(opts: {
  /** Page value `null` simulates a null `data` payload (no error). */
  pages?: Record<string, Array<Array<Record<string, unknown>> | null>>;
  /** HEAD-count result per table; missing → null count (loader treats as 0). */
  counts?: Record<string, number>;
  /** maybeSingle() result per table; missing → null row (no error). */
  singles?: Record<string, Record<string, unknown> | null>;
  errors?: Record<string, { message: string }>;
}) {
  const rangeCalls: Record<string, number> = {};
  const chains: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockImplementation(() => {
        const error = opts.errors?.[table];
        if (error) return Promise.resolve({ data: null, error });
        const pageIndex = rangeCalls[table] ?? 0;
        rangeCalls[table] = pageIndex + 1;
        const pagesForTable = opts.pages?.[table];
        // `null` page → data:null payload; missing page (past end) → [].
        const page =
          pagesForTable === undefined || pagesForTable[pageIndex] === undefined
            ? []
            : pagesForTable[pageIndex];
        return Promise.resolve({ data: page, error: null });
      }),
      maybeSingle: vi.fn().mockImplementation(() => {
        const error = opts.errors?.[table];
        if (error) return Promise.resolve({ data: null, error });
        return Promise.resolve({ data: opts.singles?.[table] ?? null, error: null });
      }),
      // Thenable: awaiting the chain (count/HEAD reads) resolves here.
      then: vi.fn().mockImplementation((resolve: (v: unknown) => unknown) => {
        const error = opts.errors?.[table];
        const result = error
          ? { count: null, error }
          : { count: opts.counts?.[table] ?? null, error: null };
        return Promise.resolve(result).then(resolve);
      })
    };
    chains[table] = chain;
    return chain;
  });
  return { client: { from }, chains };
}

const SINCE = "2026-07-01T12:34:56.000Z";
const WINDOW = { sinceIso: SINCE, aiSpendSinceIso: SINCE };

describe("loadBillableUsageSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sums SMS both ways, settled + forwarded voice seconds, and AI spend since the anchor", async () => {
    const { client, chains } = makeUsageClient({
      pages: {
        daily_usage: [[{ sms_sent: 12 }, { sms_sent: 3 }, { sms_sent: null }]],
        voice_settlements: [[{ billable_seconds: 120 }, { billable_seconds: null }]],
        voice_forwarded_call_meter: [[{ billable_seconds: 60 }]],
        owner_chat_model_spend: [[{ spend_micros: 2_000_000 }, { spend_micros: "500000" }]]
      },
      counts: { sms_inbound_jobs: 27 }
    });

    const usage = await loadBillableUsageSince("biz-1", WINDOW, client as never);

    expect(usage).toEqual({
      smsSent: 15,
      smsReceived: 27,
      voiceSeconds: 180,
      aiSpendMicros: 2_500_000
    });
    // The SMS reads filter on the UTC day / instant of the anchor; the
    // timestamp reads filter on the full instant.
    expect(chains.daily_usage.gte).toHaveBeenCalledWith("usage_date", "2026-07-01");
    expect(chains.sms_inbound_jobs.gte).toHaveBeenCalledWith("created_at", SINCE);
    expect(chains.sms_inbound_jobs.select).toHaveBeenCalledWith("id", {
      count: "exact",
      head: true
    });
    expect(chains.voice_settlements.gte).toHaveBeenCalledWith("created_at", SINCE);
    expect(chains.voice_forwarded_call_meter.gte).toHaveBeenCalledWith("created_at", SINCE);
    expect(chains.owner_chat_model_spend.gte).toHaveBeenCalledWith("period_start", SINCE);
    expect(chains.daily_usage.eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("sums EVERY AI-spend row when the window has no period filter (first-paid fallback)", async () => {
    const { client, chains } = makeUsageClient({
      pages: {
        owner_chat_model_spend: [[{ spend_micros: 1_000_000 }, { spend_micros: 250_000 }]]
      }
    });
    const usage = await loadBillableUsageSince(
      "biz-1",
      { sinceIso: SINCE, aiSpendSinceIso: null },
      client as never
    );
    expect(usage.aiSpendMicros).toBe(1_250_000);
    expect(chains.owner_chat_model_spend.gte).not.toHaveBeenCalled();
  });

  it("ignores negative or malformed AI spend values and tolerates null data payloads", async () => {
    const { client } = makeUsageClient({
      pages: {
        daily_usage: [null],
        voice_settlements: [null],
        voice_forwarded_call_meter: [null],
        owner_chat_model_spend: [
          [{ spend_micros: -5 }, { spend_micros: "garbage" }, { spend_micros: null }]
        ]
      }
    });
    const usage = await loadBillableUsageSince("biz-1", WINDOW, client as never);
    // Missing count config → null count from PostgREST → 0 received.
    expect(usage).toEqual({ smsSent: 0, smsReceived: 0, voiceSeconds: 0, aiSpendMicros: 0 });
  });

  it("pages past the 1000-row PostgREST cap on every table", async () => {
    const fullPage = (row: Record<string, unknown>) =>
      Array.from({ length: 1000 }, () => ({ ...row }));
    const { client, chains } = makeUsageClient({
      pages: {
        daily_usage: [fullPage({ sms_sent: 1 }), [{ sms_sent: 5 }]],
        voice_settlements: [fullPage({ billable_seconds: 1 }), [{ billable_seconds: null }]],
        voice_forwarded_call_meter: [
          fullPage({ billable_seconds: 1 }),
          [{ billable_seconds: null }]
        ],
        owner_chat_model_spend: [fullPage({ spend_micros: 10 }), [{ spend_micros: 7 }]]
      }
    });
    const usage = await loadBillableUsageSince("biz-1", WINDOW, client as never);
    expect(usage.smsSent).toBe(1005);
    expect(usage.voiceSeconds).toBe(2000);
    expect(usage.aiSpendMicros).toBe(10_007);
    // Two range fetches per table: the full page, then the tail.
    for (const table of [
      "daily_usage",
      "voice_settlements",
      "voice_forwarded_call_meter",
      "owner_chat_model_spend"
    ]) {
      expect(client.from.mock.calls.filter(([t]) => t === table)).toHaveLength(2);
    }
    expect(chains.daily_usage).toBeDefined();
  });

  it("tolerates a null AI-spend data payload", async () => {
    const { client } = makeUsageClient({ pages: { owner_chat_model_spend: [null] } });
    const usage = await loadBillableUsageSince("biz-1", WINDOW, client as never);
    expect(usage.aiSpendMicros).toBe(0);
  });

  it.each([
    "daily_usage",
    "sms_inbound_jobs",
    "voice_settlements",
    "voice_forwarded_call_meter",
    "owner_chat_model_spend"
  ])("throws (fail closed) when the %s read errors", async (table) => {
    const { client } = makeUsageClient({ errors: { [table]: { message: "boom" } } });
    await expect(loadBillableUsageSince("biz-1", WINDOW, client as never)).rejects.toThrow(
      `loadBillableUsageSince(${table}): boom`
    );
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeUsageClient({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const usage = await loadBillableUsageSince("biz-1", WINDOW);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(usage).toEqual({ smsSent: 0, smsReceived: 0, voiceSeconds: 0, aiSpendMicros: 0 });
  });
});

describe("applyBonusFundedUsageOffsets", () => {
  it("subtracts each lane and leaves inbound SMS untouched", () => {
    expect(
      applyBonusFundedUsageOffsets(
        { smsSent: 10, smsReceived: 5, voiceSeconds: 100, aiSpendMicros: 1_000 },
        { smsSent: 4, voiceSeconds: 30, aiSpendMicros: 400 }
      )
    ).toEqual({ smsSent: 6, smsReceived: 5, voiceSeconds: 70, aiSpendMicros: 600 });
  });

  it("clamps every lane at zero when an offset exceeds the metered amount", () => {
    expect(
      applyBonusFundedUsageOffsets(
        { smsSent: 2, smsReceived: 9, voiceSeconds: 10, aiSpendMicros: 5 },
        { smsSent: 5, voiceSeconds: 99, aiSpendMicros: 50 }
      )
    ).toEqual({ smsSent: 0, smsReceived: 9, voiceSeconds: 0, aiSpendMicros: 0 });
  });
});

describe("loadBonusFundedUsageOffsets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives voice bonus seconds from settlements beyond the plan reservation", async () => {
    const { client, chains } = makeUsageClient({
      pages: {
        voice_reservations: [
          [
            // Spilled into bonus: 160 settled, 100 covered by the plan.
            { reserved_included_seconds: 100, voice_settlements: [{ billable_seconds: 160 }] },
            // Fully plan-funded call contributes 0.
            { reserved_included_seconds: 300, voice_settlements: [{ billable_seconds: 120 }] },
            // Unfinalized/null settlement contributes 0.
            { reserved_included_seconds: 0, voice_settlements: [{ billable_seconds: null }] },
            // Multi-settlement embed sums first (50 + 40 vs 60 included).
            {
              reserved_included_seconds: 60,
              voice_settlements: [{ billable_seconds: 50 }, { billable_seconds: 40 }, null]
            },
            // Junk settlement values count 0; missing embed counts 0.
            { reserved_included_seconds: 10, voice_settlements: [{ billable_seconds: "junk" }] },
            { reserved_included_seconds: 10, voice_settlements: null },
            // Malformed or negative reserved_included skips the row entirely.
            { reserved_included_seconds: null, voice_settlements: [{ billable_seconds: 500 }] },
            { reserved_included_seconds: -5, voice_settlements: [{ billable_seconds: 500 }] }
          ]
        ]
      }
    });

    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);

    expect(offsets.voiceSeconds).toBe(60 + 0 + 0 + 30 + 0 + 0);
    expect(chains.voice_reservations.select).toHaveBeenCalledWith(
      "reserved_included_seconds, voice_settlements!inner(billable_seconds)"
    );
    expect(chains.voice_reservations.eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(chains.voice_reservations.gte).toHaveBeenCalledWith(
      "voice_settlements.created_at",
      SINCE
    );
  });

  it("derives SMS bonus texts from unvoided grant consumption", async () => {
    const { client, chains } = makeUsageClient({
      pages: {
        sms_bonus_grants: [
          [
            { texts_purchased: 500, texts_remaining: 120 },
            // Remaining above purchased clamps to 0 rather than going negative.
            { texts_purchased: 100, texts_remaining: 150 },
            // Malformed values on either side skip the row.
            { texts_purchased: null, texts_remaining: 10 },
            { texts_purchased: "junk", texts_remaining: 0 },
            { texts_purchased: 5, texts_remaining: "junk" }
          ]
        ]
      }
    });

    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);

    expect(offsets.smsSent).toBe(380);
    // Voided grants are excluded: the void RPCs zero texts_remaining, which
    // would fake full consumption (and voided means the money went back).
    expect(chains.sms_bonus_grants.is).toHaveBeenCalledWith("voided_at", null);
  });

  it("attributes chat spend above the tier base cap per window, clamped to unvoided credit", async () => {
    const starterCap = chatSpendBaseCapMicrosForTier("starter");
    const { client, chains } = makeUsageClient({
      singles: { businesses: { tier: "starter" } },
      pages: {
        owner_chat_model_spend: [
          [
            { spend_micros: starterCap + 300_000 },
            // At/below the cap contributes 0; junk and null count 0.
            { spend_micros: starterCap - 1 },
            { spend_micros: "garbage" },
            { spend_micros: null }
          ]
        ],
        chat_spend_credit_grants: [
          [
            { credit_micros: 1_000_000 },
            { credit_micros: -5 },
            { credit_micros: "junk" },
            { credit_micros: null }
          ]
        ]
      }
    });

    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);

    expect(offsets.aiSpendMicros).toBe(300_000);
    expect(chains.owner_chat_model_spend.gte).toHaveBeenCalledWith("period_start", SINCE);
    expect(chains.chat_spend_credit_grants.is).toHaveBeenCalledWith("voided_at", null);
  });

  it("clamps the chat offset to the pack credit ceiling", async () => {
    const standardCap = chatSpendBaseCapMicrosForTier(null);
    const { client } = makeUsageClient({
      // Missing business row falls back to the standard cap like the meter.
      pages: {
        owner_chat_model_spend: [[{ spend_micros: standardCap + 2_000_000 }]],
        chat_spend_credit_grants: [[{ credit_micros: 500_000 }]]
      }
    });
    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);
    expect(offsets.aiSpendMicros).toBe(500_000);
  });

  it("keeps a zero chat offset when the tenant has no packs, even with overage", async () => {
    const standardCap = chatSpendBaseCapMicrosForTier(null);
    const { client } = makeUsageClient({
      // Live-settle overshoot past the base cap with zero credits must stay
      // withheld: ceiling 0 clamps the offset to 0.
      pages: { owner_chat_model_spend: [[{ spend_micros: standardCap + 900_000 }]] }
    });
    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);
    expect(offsets.aiSpendMicros).toBe(0);
  });

  it("sums every chat spend window when the anchor has no period filter", async () => {
    const standardCap = chatSpendBaseCapMicrosForTier(null);
    const { client, chains } = makeUsageClient({
      pages: {
        owner_chat_model_spend: [
          [{ spend_micros: standardCap + 100_000 }, { spend_micros: standardCap + 50_000 }]
        ],
        chat_spend_credit_grants: [[{ credit_micros: 5_000_000 }]]
      }
    });
    const offsets = await loadBonusFundedUsageOffsets(
      "biz-1",
      { sinceIso: SINCE, aiSpendSinceIso: null },
      client as never
    );
    // Per-window attribution: each monthly row is measured against the cap.
    expect(offsets.aiSpendMicros).toBe(150_000);
    expect(chains.owner_chat_model_spend.gte).not.toHaveBeenCalled();
  });

  it("tolerates null data payloads on every offset read", async () => {
    const { client } = makeUsageClient({
      pages: {
        voice_reservations: [null],
        sms_bonus_grants: [null],
        owner_chat_model_spend: [null],
        chat_spend_credit_grants: [null]
      }
    });
    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);
    expect(offsets).toEqual({ voiceSeconds: 0, smsSent: 0, aiSpendMicros: 0 });
  });

  it("pages past the 1000-row PostgREST cap on every offset table", async () => {
    const fullPage = (row: Record<string, unknown>) =>
      Array.from({ length: 1000 }, () => ({ ...row }));
    const { client } = makeUsageClient({
      pages: {
        voice_reservations: [
          fullPage({ reserved_included_seconds: 0, voice_settlements: [{ billable_seconds: 1 }] }),
          [{ reserved_included_seconds: 0, voice_settlements: [{ billable_seconds: 5 }] }]
        ],
        sms_bonus_grants: [
          fullPage({ texts_purchased: 2, texts_remaining: 1 }),
          [{ texts_purchased: 10, texts_remaining: 3 }]
        ],
        owner_chat_model_spend: [fullPage({ spend_micros: 1 }), [{ spend_micros: 1 }]],
        chat_spend_credit_grants: [
          fullPage({ credit_micros: 10 }),
          [{ credit_micros: 3 }]
        ]
      }
    });
    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never);
    expect(offsets.voiceSeconds).toBe(1005);
    expect(offsets.smsSent).toBe(1007);
    // Every spend row is at/below the cap, so chat attribution stays 0.
    expect(offsets.aiSpendMicros).toBe(0);
  });

  it.each([
    "voice_reservations",
    "sms_bonus_grants",
    "businesses",
    "owner_chat_model_spend",
    "chat_spend_credit_grants"
  ])("throws (fail closed) when the %s read errors", async (table) => {
    const { client } = makeUsageClient({ errors: { [table]: { message: "boom" } } });
    await expect(loadBonusFundedUsageOffsets("biz-1", WINDOW, client as never)).rejects.toThrow(
      `loadBonusFundedUsageOffsets(${table}): boom`
    );
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeUsageClient({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const offsets = await loadBonusFundedUsageOffsets("biz-1", WINDOW);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(offsets).toEqual({ voiceSeconds: 0, smsSent: 0, aiSpendMicros: 0 });
  });
});

describe("loadBillableUsageCarveOutCents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads and prices in one call", async () => {
    const { client } = makeUsageClient({
      pages: {
        daily_usage: [[{ sms_sent: 100 }]],
        voice_settlements: [[{ billable_seconds: 50 * 60 }]],
        owner_chat_model_spend: [[{ spend_micros: 1_000_000 }]]
      },
      counts: { sms_inbound_jobs: 60 }
    });
    const result = await loadBillableUsageCarveOutCents("biz-1", WINDOW, client as never);
    expect(result.usage).toEqual({
      smsSent: 100,
      smsReceived: 60,
      voiceSeconds: 3000,
      aiSpendMicros: 1_000_000
    });
    // No grants and no reservations: offsets are all zero and the adjusted
    // snapshot equals the raw one.
    expect(result.offsets).toEqual({ voiceSeconds: 0, smsSent: 0, aiSpendMicros: 0 });
    expect(result.adjustedUsage).toEqual(result.usage);
    expect(result.cents).toBe(
      Math.round(
        100 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
          60 * ENTERPRISE_UNIT_COSTS.smsInboundCentsPerMessage +
          50 * ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute +
          100
      )
    );
  });

  it("prices only plan-funded usage when every lane has a bonus offset", async () => {
    const starterCap = chatSpendBaseCapMicrosForTier("starter");
    const { client } = makeUsageClient({
      singles: { businesses: { tier: "starter" } },
      pages: {
        daily_usage: [[{ sms_sent: 100 }]],
        voice_settlements: [[{ billable_seconds: 600 }]],
        voice_forwarded_call_meter: [[{ billable_seconds: 60 }]],
        // Read twice (total, then offset): stack the same row per query.
        owner_chat_model_spend: [
          [{ spend_micros: starterCap + 500_000 }],
          [{ spend_micros: starterCap + 500_000 }]
        ],
        voice_reservations: [
          [{ reserved_included_seconds: 480, voice_settlements: [{ billable_seconds: 600 }] }]
        ],
        sms_bonus_grants: [[{ texts_purchased: 50, texts_remaining: 10 }]],
        chat_spend_credit_grants: [[{ credit_micros: 2_000_000 }]]
      },
      counts: { sms_inbound_jobs: 10 }
    });

    const result = await loadBillableUsageCarveOutCents("biz-1", WINDOW, client as never);

    expect(result.usage).toEqual({
      smsSent: 100,
      smsReceived: 10,
      voiceSeconds: 660,
      aiSpendMicros: starterCap + 500_000
    });
    expect(result.offsets).toEqual({
      voiceSeconds: 120,
      smsSent: 40,
      aiSpendMicros: 500_000
    });
    // The forwarded 60 seconds survive: the voice offset is derived from
    // settled calls only, so it can never eat the human-leg meter.
    expect(result.adjustedUsage).toEqual({
      smsSent: 60,
      smsReceived: 10,
      voiceSeconds: 540,
      aiSpendMicros: starterCap
    });
    expect(result.cents).toBe(computeBillableUsageCents(result.adjustedUsage));
    expect(logger.info).toHaveBeenCalledWith(
      "usage carve-out: priced plan-funded usage only",
      expect.objectContaining({
        businessId: "biz-1",
        offsets: { voiceSeconds: 120, smsSent: 40, aiSpendMicros: 500_000 }
      })
    );
  });

  it("rejects when an offset read fails (fail closed, never a silent zero)", async () => {
    const { client } = makeUsageClient({
      pages: { daily_usage: [[{ sms_sent: 1 }]] },
      errors: { sms_bonus_grants: { message: "boom" } }
    });
    await expect(
      loadBillableUsageCarveOutCents("biz-1", WINDOW, client as never)
    ).rejects.toThrow("loadBonusFundedUsageOffsets(sms_bonus_grants): boom");
  });

  it("falls back to the service client when none is passed", async () => {
    const { client } = makeUsageClient({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(client as never);
    const result = await loadBillableUsageCarveOutCents("biz-1", WINDOW);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(result.cents).toBe(0);
  });
});
