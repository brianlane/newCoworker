import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  RESPONSE_TIME_SCAN_LIMIT,
  getResponseTimeStats
} from "@/lib/analytics/response-times";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-16T12:00:00Z");

type QueryResult = { data: unknown; error: { message: string } | null };

function makeClient(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "in", "order", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return { from: vi.fn(() => chain) } as never;
}

function job(status: string, waitSeconds: number) {
  const created = new Date(NOW.getTime() - 3600_000);
  return {
    status,
    created_at: created.toISOString(),
    updated_at: new Date(created.getTime() + waitSeconds * 1000).toISOString()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getResponseTimeStats", () => {
  it("computes median / p90 / average / under-a-minute share and dead-letter count", async () => {
    const client = makeClient({
      data: [
        job("done", 10),
        job("done", 30),
        job("done", 50),
        job("done", 70),
        job("done", 600),
        job("dead_letter", 0)
      ],
      error: null
    });
    const stats = await getResponseTimeStats(BIZ, { client, now: NOW });
    expect(stats).toMatchObject({
      repliedCount: 5,
      medianSeconds: 50,
      averageSeconds: 152,
      p90Seconds: 600,
      underMinuteShare: 0.6,
      deadLetterCount: 1,
      clipped: false
    });
  });

  it("clamps a negative wait (clock skew) to zero", async () => {
    const client = makeClient({ data: [job("done", -30)], error: null });
    const stats = await getResponseTimeStats(BIZ, { client, now: NOW });
    expect(stats.medianSeconds).toBe(0);
    expect(stats.repliedCount).toBe(1);
  });

  it("returns nulls when nothing replied yet (default client)", async () => {
    const client = makeClient({ data: [job("dead_letter", 0)], error: null });
    defaultClientSpy.mockReturnValue(client);
    const stats = await getResponseTimeStats(BIZ);
    expect(stats).toMatchObject({
      repliedCount: 0,
      medianSeconds: null,
      averageSeconds: null,
      p90Seconds: null,
      underMinuteShare: null,
      deadLetterCount: 1,
      clipped: false
    });
  });

  it("handles a null data payload", async () => {
    const client = makeClient({ data: null, error: null });
    const stats = await getResponseTimeStats(BIZ, { client, now: NOW });
    expect(stats.repliedCount).toBe(0);
    expect(stats.deadLetterCount).toBe(0);
  });

  it("flags a capped scan in both the empty-waits and populated paths", async () => {
    const allDead = Array.from({ length: RESPONSE_TIME_SCAN_LIMIT }, () => job("dead_letter", 0));
    const s1 = await getResponseTimeStats(BIZ, { client: makeClient({ data: allDead, error: null }), now: NOW });
    expect(s1.clipped).toBe(true);
    expect(s1.repliedCount).toBe(0);

    const allDone = Array.from({ length: RESPONSE_TIME_SCAN_LIMIT }, () => job("done", 5));
    const s2 = await getResponseTimeStats(BIZ, { client: makeClient({ data: allDone, error: null }), now: NOW });
    expect(s2.clipped).toBe(true);
    expect(s2.repliedCount).toBe(RESPONSE_TIME_SCAN_LIMIT);
  });

  it("throws on a scan error", async () => {
    const client = makeClient({ data: null, error: { message: "scan boom" } });
    await expect(getResponseTimeStats(BIZ, { client, now: NOW })).rejects.toThrow(/scan boom/);
  });
});
