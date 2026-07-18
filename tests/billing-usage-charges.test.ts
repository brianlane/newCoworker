import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  computeBillableUsageCents,
  loadBillableUsageCarveOutCents,
  loadBillableUsageSince,
  resolveUsageCarveOutWindow
} from "@/lib/billing/usage-charges";
import {
  ENTERPRISE_UNIT_COSTS,
  VOICE_ALL_IN_CENTS_PER_MINUTE
} from "@/lib/plans/enterprise-pricing";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

describe("computeBillableUsageCents", () => {
  it("prices SMS, voice, and AI spend at platform cost with a single final round", () => {
    const cents = computeBillableUsageCents({
      smsSent: 100,
      voiceSeconds: 50 * 60,
      aiSpendMicros: 1_234_999 // $1.234999
    });
    expect(cents).toBe(
      Math.round(
        100 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
          50 * VOICE_ALL_IN_CENTS_PER_MINUTE +
          123.4999
      )
    );
  });

  it("returns 0 for a tenant with no usage", () => {
    expect(computeBillableUsageCents({ smsSent: 0, voiceSeconds: 0, aiSpendMicros: 0 })).toBe(0);
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
 * calls; `errors[table]` short-circuits the read with an error.
 */
function makeUsageClient(opts: {
  /** Page value `null` simulates a null `data` payload (no error). */
  pages?: Record<string, Array<Array<Record<string, unknown>> | null>>;
  errors?: Record<string, { message: string }>;
}) {
  const rangeCalls: Record<string, number> = {};
  const chains: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
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

  it("sums SMS, settled + forwarded voice seconds, and AI spend since the anchor", async () => {
    const { client, chains } = makeUsageClient({
      pages: {
        daily_usage: [[{ sms_sent: 12 }, { sms_sent: 3 }, { sms_sent: null }]],
        voice_settlements: [[{ billable_seconds: 120 }, { billable_seconds: null }]],
        voice_forwarded_call_meter: [[{ billable_seconds: 60 }]],
        owner_chat_model_spend: [[{ spend_micros: 2_000_000 }, { spend_micros: "500000" }]]
      }
    });

    const usage = await loadBillableUsageSince("biz-1", WINDOW, client as never);

    expect(usage).toEqual({ smsSent: 15, voiceSeconds: 180, aiSpendMicros: 2_500_000 });
    // The SMS read filters on the UTC day of the anchor; the timestamp reads
    // filter on the full instant.
    expect(chains.daily_usage.gte).toHaveBeenCalledWith("usage_date", "2026-07-01");
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
    expect(usage).toEqual({ smsSent: 0, voiceSeconds: 0, aiSpendMicros: 0 });
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
    expect(usage).toEqual({ smsSent: 0, voiceSeconds: 0, aiSpendMicros: 0 });
  });
});

describe("loadBillableUsageCarveOutCents", () => {
  it("loads and prices in one call", async () => {
    const { client } = makeUsageClient({
      pages: {
        daily_usage: [[{ sms_sent: 100 }]],
        voice_settlements: [[{ billable_seconds: 50 * 60 }]],
        owner_chat_model_spend: [[{ spend_micros: 1_000_000 }]]
      }
    });
    const result = await loadBillableUsageCarveOutCents("biz-1", WINDOW, client as never);
    expect(result.usage).toEqual({
      smsSent: 100,
      voiceSeconds: 3000,
      aiSpendMicros: 1_000_000
    });
    expect(result.cents).toBe(
      Math.round(
        100 * ENTERPRISE_UNIT_COSTS.smsOutboundCentsPerMessage +
          50 * VOICE_ALL_IN_CENTS_PER_MINUTE +
          100
      )
    );
  });
});
