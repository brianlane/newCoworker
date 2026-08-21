/**
 * Campaign audience preview (src/lib/campaigns/audience.ts): the composer's
 * pre-schedule count. Must mirror the sweep's snapshot filters, customer +
 * emailable + not-unsubscribed scan, case-insensitive tag match, address
 * de-dupe, recipient cap, and flag instagram-prospect contacts pending
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
 * Contacts-scan mock, same chain shape as the campaigns-send tests, except
 * the TERMINAL builder methods (`limit` for the preview scan, `contains` for
 * the tag count) resolve a real promise: awaiting a magic thenable makes v8
 * mis-attribute the awaited chain statement as uncovered.
 */
function makeDb(
  contacts: ContactRow[] | null,
  error: { message: string } | null = null,
  count: number | null = null,
  /** The board read that drives the closed-customer rule; none by default. */
  stages: Array<{ id: string; pipeline_id: string; name: string; position: number }> = []
) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const result = { data: contacts, error, count };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    const record = (m: string, args: unknown[]) => {
      if (table === "contacts") calls.push({ name: m, args });
    };
    for (const m of ["select", "eq", "not", "is", "in"]) {
      chain[m] = vi.fn((...args: unknown[]) => {
        record(m, args);
        return chain;
      });
    }
    // `order` is the board read's terminal and a passthrough for contacts.
    chain.order = vi.fn((...args: unknown[]) => {
      record("order", args);
      return table === "pipeline_stages"
        ? Promise.resolve({ data: stages, error: null })
        : chain;
    });
    for (const m of ["limit", "contains"]) {
      chain[m] = vi.fn((...args: unknown[]) => {
        record(m, args);
        return Promise.resolve(result);
      });
    }
    return chain;
  };
  return { db: { from: vi.fn((t: string) => chainFor(t)) } as never, calls };
}

/** A board with the stages the closed-customer rule anchors on. */
const WON_BOARD = [
  { id: "s0", pipeline_id: "p1", name: "New Lead", position: 0 },
  { id: "s1", pipeline_id: "p1", name: "Engaged", position: 2 },
  { id: "s2", pipeline_id: "p1", name: "Won", position: 4 },
  { id: "s3", pipeline_id: "p1", name: "Onboarded", position: 5 }
];

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
    // The datalist ignores the audience filter, "Alpha"/"buyer" still offered.
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
    // CAMPAIGN_MAX_RECIPIENTS (2000) < scan limit, the count is the mail
    // count the sweep would actually snapshot, not the raw match count.
    expect(preview.recipients).toBe(2000);
  });

  it("clips on the RAW returned rows, even when the email filter drops some", async () => {
    // Query filled its bound, but a few rows lack a usable email: the
    // directory may hold more eligible contacts beyond the cap, so counts
    // must still read "at least" (Bugbot 6ca565e0).
    const rows: ContactRow[] = Array.from({ length: CAMPAIGN_AUDIENCE_SCAN_LIMIT }, (_, i) => ({
      id: `c${i}`,
      email: i < 10 ? null : `c${i}@x.test`,
      tags: []
    }));
    const { db } = makeDb(rows);
    const preview = await previewCampaignAudience(BIZ, "", db);
    expect(preview.clipped).toBe(true);
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

describe("previewCampaignAudience: the subtractions", () => {
  it("drops the excluded tag and closed customers, and counts what remains", async () => {
    const { db } = makeDb(
      [
        { id: "a", email: "a@x.test", tags: ["VIP"] },
        { id: "b", email: "b@x.test", tags: ["VIP", "Onboarding"] },
        { id: "c", email: "c@x.test", tags: ["VIP", "Won"] }
      ],
      null,
      null,
      WON_BOARD
    );
    const out = await previewCampaignAudience(BIZ, "vip", db, { excludeTag: "onboarding" });
    // Only "a": b carries the excluded tag, c already bought.
    expect(out.recipients).toBe(1);
  });

  it("counts closed customers when the owner asks for them", async () => {
    const { db } = makeDb(
      [
        { id: "a", email: "a@x.test", tags: ["VIP"] },
        { id: "c", email: "c@x.test", tags: ["VIP", "Won"] }
      ],
      null,
      null,
      WON_BOARD
    );
    const out = await previewCampaignAudience(BIZ, "vip", db, { includeClosed: true });
    expect(out.recipients).toBe(2);
  });

  it("defaults to the safe reading when no options are passed", async () => {
    // Every existing caller keeps its meaning: subtract nothing by tag, and
    // leave closed customers out.
    const { db } = makeDb(
      [
        { id: "a", email: "a@x.test", tags: ["Engaged"] },
        { id: "c", email: "c@x.test", tags: ["Won"] }
      ],
      null,
      null,
      WON_BOARD
    );
    expect((await previewCampaignAudience(BIZ, "", db)).recipients).toBe(1);
  });

  it("still offers every tag in the picker, including excluded ones", async () => {
    // The datalist is what an owner could target, so it must not shrink as
    // they type an exclusion.
    const { db } = makeDb(
      [
        { id: "a", email: "a@x.test", tags: ["VIP"] },
        { id: "b", email: "b@x.test", tags: ["Onboarding"] }
      ],
      null,
      null,
      WON_BOARD
    );
    const out = await previewCampaignAudience(BIZ, "", db, { excludeTag: "onboarding" });
    expect(out.tags).toEqual(["Onboarding", "VIP"]);
    expect(out.recipients).toBe(1);
  });
});
