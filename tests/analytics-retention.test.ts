import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { getRetentionOverview } from "@/lib/analytics/retention";
import { ENGAGEMENT_SCAN_LIMIT } from "@/lib/analytics/engagement";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-16T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

type QueryResult = { data: unknown; error: { message: string } | null };

function makeClient(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return { from: vi.fn(() => chain) } as never;
}

function contact(createdDaysAgo: number, lastDaysAgo: number | null, interactions = 1) {
  return {
    created_at: daysAgo(createdDaysAgo),
    last_interaction_at: lastDaysAgo === null ? null : daysAgo(lastDaysAgo),
    total_interaction_count: interactions
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRetentionOverview", () => {
  it("splits engaged customers into retained / at-risk / lapsed with returning + new counts", async () => {
    const client = makeClient({
      data: [
        contact(200, 5), // retained + returning (older than window, active in it)
        contact(10, 2), // retained, created in window (new, not returning)
        contact(200, 45), // at risk
        contact(400, 120), // lapsed
        contact(5, null, 0), // never interacted: not engaged; new in window
        contact(3, null, 2) // no last stamp but counted interactions → "new" band → retained
      ],
      error: null
    });
    const overview = await getRetentionOverview(BIZ, { client, now: NOW });
    expect(overview).toMatchObject({
      engagedEver: 5,
      retained: 3,
      atRisk: 1,
      lapsed: 1,
      returning: 1,
      newInWindow: 3,
      retentionRate: 0.6,
      clipped: false
    });
  });

  it("treats junk created_at as not-new and rate stays null with zero engagement (default client)", async () => {
    const client = makeClient({
      data: [
        { created_at: "garbage", last_interaction_at: null, total_interaction_count: 0 }
      ],
      error: null
    });
    defaultClientSpy.mockReturnValue(client);
    const overview = await getRetentionOverview(BIZ);
    expect(overview).toMatchObject({
      engagedEver: 0,
      retentionRate: null,
      newInWindow: 0
    });
  });

  it("a retained row with junk created_at cannot count as returning", async () => {
    const client = makeClient({
      data: [{ created_at: "garbage", last_interaction_at: daysAgo(2), total_interaction_count: 3 }],
      error: null
    });
    const overview = await getRetentionOverview(BIZ, { client, now: NOW });
    expect(overview).toMatchObject({ retained: 1, returning: 0 });
  });

  it("handles a null data payload and flags a capped scan", async () => {
    const empty = await getRetentionOverview(BIZ, {
      client: makeClient({ data: null, error: null }),
      now: NOW
    });
    expect(empty.engagedEver).toBe(0);
    expect(empty.clipped).toBe(false);

    const full = Array.from({ length: ENGAGEMENT_SCAN_LIMIT }, () => contact(200, 5));
    const capped = await getRetentionOverview(BIZ, {
      client: makeClient({ data: full, error: null }),
      now: NOW
    });
    expect(capped.clipped).toBe(true);
  });

  it("throws on a scan error", async () => {
    await expect(
      getRetentionOverview(BIZ, {
        client: makeClient({ data: null, error: { message: "scan boom" } }),
        now: NOW
      })
    ).rejects.toThrow(/scan boom/);
  });
});
