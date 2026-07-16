import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  QUOTE_LOST_TAG,
  QUOTE_STAGE_TAGS,
  getQuoteFunnel,
  quoteStageForTags
} from "@/lib/analytics/quote-funnel";
import { ENGAGEMENT_SCAN_LIMIT } from "@/lib/analytics/engagement";

const BIZ = "11111111-1111-4111-8111-111111111111";

type QueryResult = { data: unknown; error: { message: string } | null };

function makeClient(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  const calls: Array<{ name: string; args: unknown[] }> = [];
  for (const m of ["select", "eq", "overlaps", "limit"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ name: m, args });
      return chain;
    });
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return { client: { from: vi.fn(() => chain) } as never, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("quoteStageForTags", () => {
  it("picks the FURTHEST ladder stage a contact carries", () => {
    expect(quoteStageForTags(["quote-requested"])).toBe("quote-requested");
    expect(quoteStageForTags(["quote-requested", "quote-presented"])).toBe("quote-presented");
    expect(quoteStageForTags(["VIP", "Quote-Won", "quote-requested"])).toBe("quote-won");
  });

  it("treats quote-lost as terminal over every ladder stage", () => {
    expect(quoteStageForTags(["quote-won", "quote-lost"])).toBe("quote-lost");
  });

  it("returns null for contacts with no stage tag", () => {
    expect(quoteStageForTags(["VIP", "spanish-speaking"])).toBeNull();
    expect(quoteStageForTags([])).toBeNull();
  });
});

describe("getQuoteFunnel", () => {
  it("buckets each contact once and computes the win rate", async () => {
    const { client, calls } = makeClient({
      data: [
        { tags: ["quote-requested"] },
        { tags: ["quote-requested", "quote-received"] },
        { tags: ["quote-presented"] },
        { tags: ["quote-won", "quote-requested"] },
        { tags: ["quote-lost", "quote-presented"] }
      ],
      error: null
    });
    const funnel = await getQuoteFunnel(BIZ, { client });
    expect(funnel.counts).toEqual({
      "quote-requested": 1,
      "quote-received": 1,
      "quote-presented": 1,
      "quote-won": 1,
      "quote-lost": 1
    });
    expect(funnel.totalTracked).toBe(5);
    expect(funnel.conversionRate).toBe(0.2);
    expect(funnel.clipped).toBe(false);
    // The scan pre-filters on the stage tags (GIN overlaps).
    expect(calls.find((c) => c.name === "overlaps")?.args).toEqual([
      "tags",
      [...QUOTE_STAGE_TAGS, QUOTE_LOST_TAG]
    ]);
  });

  it("returns a null rate for an empty funnel and tolerates null tags/data (default client)", async () => {
    const { client } = makeClient({ data: [{ tags: null }], error: null });
    defaultClientSpy.mockReturnValue(client);
    const funnel = await getQuoteFunnel(BIZ);
    expect(funnel.totalTracked).toBe(0);
    expect(funnel.conversionRate).toBeNull();

    const empty = await getQuoteFunnel(BIZ, {
      client: makeClient({ data: null, error: null }).client
    });
    expect(empty.totalTracked).toBe(0);
  });

  it("flags a capped scan", async () => {
    const full = Array.from({ length: ENGAGEMENT_SCAN_LIMIT }, () => ({
      tags: ["quote-requested"]
    }));
    const funnel = await getQuoteFunnel(BIZ, {
      client: makeClient({ data: full, error: null }).client
    });
    expect(funnel.clipped).toBe(true);
  });

  it("throws on a scan error", async () => {
    await expect(
      getQuoteFunnel(BIZ, { client: makeClient({ data: null, error: { message: "boom" } }).client })
    ).rejects.toThrow(/boom/);
  });
});
