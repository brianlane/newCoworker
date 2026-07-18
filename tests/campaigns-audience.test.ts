/**
 * Campaign audience preview (src/lib/campaigns/audience.ts): the composer's
 * pre-schedule count. Must mirror the sweep's snapshot filters — customer +
 * emailable + not-unsubscribed scan, case-insensitive tag match, address
 * de-dupe, recipient cap — and flag instagram-prospect contacts pending
 * review. Plus the tag-count helper behind the Marketing page counter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));

import {
  countContactsTagged,
  previewCampaignAudience
} from "@/lib/campaigns/audience";
import { INSTAGRAM_PROSPECT_TAG } from "@/lib/ai-flows/templates";
import { CAMPAIGN_AUDIENCE_SCAN_LIMIT } from "@/lib/campaigns/send";

const BIZ = "11111111-1111-4111-8111-111111111111";

type ContactRow = { id: string; email: string | null; tags?: string[] | null };

/**
 * Contacts-scan mock — same chain shape as the campaigns-send tests, except
 * the TERMINAL builder methods (`limit` for the preview scan, `contains` for
 * the tag count) resolve a real promise: awaiting a magic thenable makes v8
 * mis-attribute the awaited chain statement as uncovered.
 */
function makeDb(
  contacts: ContactRow[] | null,
  error: { message: string } | null = null,
  count: number | null = null
) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const result = { data: contacts, error, count };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "is", "in", "order"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ name: m, args });
      return chain;
    });
  }
  for (const m of ["limit", "contains"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ name: m, args });
      return Promise.resolve(result);
    });
  }
  return { db: { from: vi.fn(() => chain) } as never, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("previewCampaignAudience", () => {
  it("counts emailable customers with snapshot-identical filters and de-dupes addresses", async () => {
    const { db, calls } = makeDb([
      { id: "a", email: "jane@x.test", tags: ["VIP"] },
      { id: "b", email: "JANE@x.test ", tags: [] }, // same address → one mail
      { id: "c", email: null }, // filtered defensively
      { id: "d", email: "not-an-email" } // no @ → dropped
    ]);
    const preview = await previewCampaignAudience(BIZ, "", db);
    expect(preview).toEqual({
      recipients: 1,
      needsReview: 0,
      clipped: false,
      tags: ["VIP"]
    });
    // The scan applied the exact snapshot filters.
    expect(calls.find((c) => c.name === "is")?.args).toEqual(["marketing_unsubscribed_at", null]);
    expect(calls.filter((c) => c.name === "eq").map((c) => c.args)).toEqual([
      ["business_id", BIZ],
      ["type", "customer"]
    ]);
    expect(calls.find((c) => c.name === "limit")?.args).toEqual([CAMPAIGN_AUDIENCE_SCAN_LIMIT]);
  });

  it("matches the audience tag case-insensitively and trims it", async () => {
    const { db } = makeDb([
      { id: "a", email: "a@x.test", tags: ["VIP"] },
      { id: "b", email: "b@x.test", tags: [" vip "] },
      { id: "c", email: "c@x.test", tags: ["other"] },
      { id: "d", email: "d@x.test", tags: null }
    ]);
    const preview = await previewCampaignAudience(BIZ, "  Vip ", db);
    expect(preview.recipients).toBe(2);
  });

  it("flags recipients still carrying the instagram-prospect review tag", async () => {
    const { db } = makeDb([
      { id: "a", email: "a@x.test", tags: [INSTAGRAM_PROSPECT_TAG, "VIP"] },
      { id: "b", email: "b@x.test", tags: ["Instagram-Prospect"] }, // case variant
      { id: "c", email: "c@x.test", tags: ["VIP"] },
      { id: "d", email: "d@x.test", tags: null } // tagless rows count as clean
    ]);
    const preview = await previewCampaignAudience(BIZ, "", db);
    expect(preview.recipients).toBe(4);
    expect(preview.needsReview).toBe(2);
  });

  it("lists distinct tags across the whole emailable directory, sorted, first casing kept", async () => {
    const { db } = makeDb([
      { id: "a", email: "a@x.test", tags: ["VIP", "buyer "] },
      { id: "b", email: "b@x.test", tags: ["vip", "Alpha"] },
      { id: "c", email: "c@x.test", tags: ["", "  "] } // blanks dropped
    ]);
    const preview = await previewCampaignAudience(BIZ, "vip", db);
    // The datalist ignores the audience filter — "Alpha"/"buyer" still offered.
    expect(preview.tags).toEqual(["Alpha", "buyer", "VIP"]);
    expect(preview.recipients).toBe(2);
  });

  it("reports a clipped scan and caps like the snapshot", async () => {
    const rows: ContactRow[] = Array.from({ length: CAMPAIGN_AUDIENCE_SCAN_LIMIT }, (_, i) => ({
      id: `c${i}`,
      email: `c${i}@x.test`,
      tags: []
    }));
    const { db } = makeDb(rows);
    const preview = await previewCampaignAudience(BIZ, "", db);
    expect(preview.clipped).toBe(true);
    // CAMPAIGN_MAX_RECIPIENTS (2000) < scan limit — the count is the mail
    // count the sweep would actually snapshot, not the raw match count.
    expect(preview.recipients).toBe(2000);
  });

  it("tolerates a null scan payload and surfaces scan errors", async () => {
    const empty = makeDb(null);
    expect(await previewCampaignAudience(BIZ, "", empty.db)).toEqual({
      recipients: 0,
      needsReview: 0,
      clipped: false,
      tags: []
    });
    const failing = makeDb(null, { message: "boom" });
    await expect(previewCampaignAudience(BIZ, "", failing.db)).rejects.toThrow(
      "previewCampaignAudience: boom"
    );
  });
});

describe("countContactsTagged", () => {
  it("head-counts contacts carrying the tag (emailable or not)", async () => {
    const { db, calls } = makeDb(null, null, 7);
    expect(await countContactsTagged(BIZ, INSTAGRAM_PROSPECT_TAG, db)).toBe(7);
    expect(calls.find((c) => c.name === "contains")?.args).toEqual([
      "tags",
      [INSTAGRAM_PROSPECT_TAG]
    ]);
    expect(calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
  });

  it("returns 0 on a null count and surfaces errors", async () => {
    const nullCount = makeDb(null, null, null);
    expect(await countContactsTagged(BIZ, "x", nullCount.db)).toBe(0);
    const failing = makeDb(null, { message: "boom" });
    await expect(countContactsTagged(BIZ, "x", failing.db)).rejects.toThrow(
      "countContactsTagged: boom"
    );
  });
});
