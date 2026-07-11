import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  ENGAGEMENT_SCAN_LIMIT,
  QUIET_CUSTOMER_LIMIT,
  classifyEngagement,
  getEngagementOverview
} from "@/lib/analytics/engagement";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NOW = new Date("2026-07-04T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

type QueryResult = { data?: unknown; error: { message: string } | null };

function makeClient(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (onF: (v: QueryResult) => unknown) =>
    Promise.resolve(result).then(onF);
  return { client: { from: vi.fn(() => chain) } as never, chain };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classifyEngagement", () => {
  it("bands by interaction recency: active → cooling → quiet", () => {
    expect(
      classifyEngagement({ created_at: daysAgo(400), last_interaction_at: daysAgo(5) }, NOW)
    ).toBe("active");
    expect(
      classifyEngagement({ created_at: daysAgo(400), last_interaction_at: daysAgo(45) }, NOW)
    ).toBe("cooling");
    expect(
      classifyEngagement({ created_at: daysAgo(400), last_interaction_at: daysAgo(120) }, NOW)
    ).toBe("quiet");
  });

  it("never-contacted contacts are new when recently added, quiet when old", () => {
    expect(
      classifyEngagement({ created_at: daysAgo(3), last_interaction_at: null }, NOW)
    ).toBe("new");
    expect(
      classifyEngagement({ created_at: daysAgo(200), last_interaction_at: null }, NOW)
    ).toBe("quiet");
  });

  it("tolerates junk timestamps and defaults `now`", () => {
    expect(
      classifyEngagement({ created_at: "garbage", last_interaction_at: "junk" }, NOW)
    ).toBe("quiet");
    expect(
      classifyEngagement({
        created_at: new Date().toISOString(),
        last_interaction_at: new Date().toISOString()
      })
    ).toBe("active");
  });
});

describe("getEngagementOverview", () => {
  it("counts segments and shortlists quiet customers by lifetime interactions", async () => {
    const { client, chain } = makeClient({
      data: [
        {
          customer_e164: "+15550001111",
          display_name: "Active Amy",
          created_at: daysAgo(200),
          last_interaction_at: daysAgo(2),
          total_interaction_count: 40
        },
        {
          customer_e164: "+15550002222",
          display_name: "Cooling Carl",
          created_at: daysAgo(200),
          last_interaction_at: daysAgo(60),
          total_interaction_count: 10
        },
        {
          customer_e164: "+15550003333",
          display_name: "Quiet Quinn",
          created_at: daysAgo(300),
          last_interaction_at: daysAgo(150),
          total_interaction_count: 25
        },
        {
          customer_e164: "+15550004444",
          display_name: null,
          created_at: daysAgo(300),
          last_interaction_at: null,
          total_interaction_count: 0
        },
        {
          customer_e164: "+15550005555",
          display_name: "New Nia",
          created_at: daysAgo(1),
          last_interaction_at: null,
          total_interaction_count: 0
        }
      ],
      error: null
    });
    const overview = await getEngagementOverview("biz-1", { client, now: NOW });
    expect(overview.counts).toEqual({ new: 1, active: 1, cooling: 1, quiet: 2 });
    expect(overview.total).toBe(5);
    // Most-engaged-ever quiet customer first.
    expect(overview.quietCustomers.map((q) => q.e164)).toEqual([
      "+15550003333",
      "+15550004444"
    ]);
    expect(overview.quietCustomers[0]).toEqual({
      e164: "+15550003333",
      name: "Quiet Quinn",
      lastInteractionAt: daysAgo(150),
      totalInteractions: 25
    });
    const c = chain as { eq: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> };
    expect(c.eq).toHaveBeenCalledWith("type", "customer");
    expect(c.limit).toHaveBeenCalledWith(ENGAGEMENT_SCAN_LIMIT);
  });

  it("caps the quiet shortlist", async () => {
    const rows = Array.from({ length: QUIET_CUSTOMER_LIMIT + 4 }, (_, i) => ({
      customer_e164: `+1555000${String(i).padStart(4, "0")}`,
      display_name: null,
      created_at: daysAgo(300),
      last_interaction_at: null,
      total_interaction_count: i
    }));
    const { client } = makeClient({ data: rows, error: null });
    const overview = await getEngagementOverview("biz-1", { client, now: NOW });
    expect(overview.quietCustomers).toHaveLength(QUIET_CUSTOMER_LIMIT);
  });

  it("handles a null page, throws on error, and defaults client/now", async () => {
    const { client } = makeClient({ data: null, error: null });
    const overview = await getEngagementOverview("biz-1", { client, now: NOW });
    expect(overview).toEqual({
      counts: { new: 0, active: 0, cooling: 0, quiet: 0 },
      total: 0,
      quietCustomers: []
    });

    const errClient = makeClient({ data: null, error: { message: "scan down" } });
    await expect(
      getEngagementOverview("biz-1", { client: errClient.client, now: NOW })
    ).rejects.toThrow("getEngagementOverview: scan down");

    const ok = makeClient({ data: [], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.client as never);
    expect((await getEngagementOverview("biz-1")).total).toBe(0);
  });
});
