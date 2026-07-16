import { describe, expect, it, vi } from "vitest";
import {
  buildLeadSourceOverview,
  getLeadSourceOverview,
  LEAD_SOURCE_SCAN_LIMIT,
  LEAD_SOURCE_TAG_LIMIT,
  LEAD_SOURCE_WINDOW_DAYS,
  type LeadSourceContact
} from "@/lib/analytics/lead-sources";
import { analyticsWindowStart } from "@/lib/analytics/dashboard-analytics";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Lead-source reporting: new customer contacts in the window, grouped by
 * last_channel and by tag, with engaged/claimed counts per group and an
 * honest "untracked" residue for rows carrying no source signal at all.
 */

const row = (over: Partial<LeadSourceContact> = {}): LeadSourceContact => ({
  last_channel: "sms",
  tags: ["New Lead"],
  owner_employee_id: null,
  total_interaction_count: 2,
  ...over
});

describe("buildLeadSourceOverview", () => {
  it("groups by channel and by tag with engaged/claimed counts", () => {
    const overview = buildLeadSourceOverview(
      [
        row(),
        row({ owner_employee_id: "emp-1" }),
        row({ last_channel: "voice", tags: [], total_interaction_count: 0 })
      ],
      { windowDays: 30, clipped: false }
    );
    expect(overview.totalNewContacts).toBe(3);
    expect(overview.channels).toEqual([
      { label: "sms", newContacts: 2, engaged: 2, claimed: 1 },
      { label: "voice", newContacts: 1, engaged: 0, claimed: 0 }
    ]);
    expect(overview.tags).toEqual([
      { label: "New Lead", newContacts: 2, engaged: 2, claimed: 1 }
    ]);
    expect(overview.untracked).toBe(0);
  });

  it("tags merge case-insensitively under the first-seen casing", () => {
    const overview = buildLeadSourceOverview(
      [row({ tags: ["Meta Lead"] }), row({ tags: ["meta lead", "  "] })],
      { windowDays: 30, clipped: false }
    );
    expect(overview.tags).toEqual([
      { label: "Meta Lead", newContacts: 2, engaged: 2, claimed: 0 }
    ]);
  });

  it("a contact repeating a tag (any casing) counts once in that tag's bucket", () => {
    const overview = buildLeadSourceOverview(
      [row({ tags: ["VIP", "vip", "VIP "] }), row({ tags: ["vip"] })],
      { windowDays: 30, clipped: false }
    );
    expect(overview.tags).toEqual([{ label: "VIP", newContacts: 2, engaged: 2, claimed: 0 }]);
    expect(overview.totalNewContacts).toBe(2);
  });

  it("counts a contact with no channel and no tags as untracked", () => {
    const overview = buildLeadSourceOverview(
      [
        row({ last_channel: null, tags: [] }),
        row({ last_channel: "", tags: null }),
        // A tag alone (or a channel alone) IS a signal.
        row({ last_channel: null, tags: ["Referral"] })
      ],
      { windowDays: 30, clipped: false }
    );
    expect(overview.untracked).toBe(2);
    expect(overview.channels).toEqual([]);
    expect(overview.tags).toEqual([{ label: "Referral", newContacts: 1, engaged: 1, claimed: 0 }]);
  });

  it("sorts by volume (ties alphabetically) and caps the tag list", () => {
    const rows: LeadSourceContact[] = [
      row({ tags: ["b"] }),
      row({ tags: ["b"] }),
      row({ tags: ["a"] }),
      row({ tags: ["c"] }),
      ...Array.from({ length: LEAD_SOURCE_TAG_LIMIT + 3 }, (_, i) => row({ tags: [`t${i}`] }))
    ];
    const overview = buildLeadSourceOverview(rows, { windowDays: 30, clipped: false });
    expect(overview.tags).toHaveLength(LEAD_SOURCE_TAG_LIMIT);
    expect(overview.tags[0]).toMatchObject({ label: "b", newContacts: 2 });
    // Volume tie between "a", "c", and the t* tags breaks alphabetically.
    expect(overview.tags[1].label).toBe("a");
    expect(overview.tags[2].label).toBe("c");
  });

  it("passes windowDays/clipped through", () => {
    const overview = buildLeadSourceOverview([], { windowDays: 7, clipped: true });
    expect(overview).toMatchObject({
      totalNewContacts: 0,
      untracked: 0,
      windowDays: 7,
      clipped: true
    });
  });
});

type Result = { data: unknown; error: unknown };

function mockDb(result: Result) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order", "limit"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ name: m, args });
      return chain;
    };
  }
  (chain as { then: unknown }).then = (
    resolve: (v: Result) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return { db: { from: vi.fn(() => chain) }, calls };
}

describe("getLeadSourceOverview", () => {
  const NOW = new Date("2026-07-16T00:00:00.000Z");

  it("scans the window's new customer contacts (day-aligned, newest first) and folds them", async () => {
    const { db, calls } = mockDb({ data: [row(), row({ last_channel: "voice" })], error: null });
    const overview = await getLeadSourceOverview("biz-1", { client: db as never, now: NOW });
    expect(overview.totalNewContacts).toBe(2);
    expect(overview.windowDays).toBe(LEAD_SOURCE_WINDOW_DAYS);
    expect(overview.clipped).toBe(false);
    expect(calls.some((c) => c.name === "eq" && c.args[0] === "type" && c.args[1] === "customer")).toBe(
      true
    );
    // UTC day-aligned window start — the same boundary every other analytics
    // card on the page uses.
    const gte = calls.find((c) => c.name === "gte")!;
    expect(gte.args[0]).toBe("created_at");
    expect(gte.args[1]).toBe(
      analyticsWindowStart(NOW, LEAD_SOURCE_WINDOW_DAYS).toISOString()
    );
    // Newest-first so a capped scan keeps the most recent contacts.
    const order = calls.find((c) => c.name === "order")!;
    expect(order.args).toEqual(["created_at", { ascending: false }]);
  });

  it("supports a custom window, marks a capped scan, and handles null rows", async () => {
    const capped = mockDb({
      data: Array.from({ length: LEAD_SOURCE_SCAN_LIMIT }, () => row()),
      error: null
    });
    const overview = await getLeadSourceOverview("biz-1", {
      client: capped.db as never,
      now: NOW,
      windowDays: 7
    });
    expect(overview.clipped).toBe(true);
    expect(overview.windowDays).toBe(7);

    const empty = mockDb({ data: null, error: null });
    expect(
      (await getLeadSourceOverview("biz-1", { client: empty.db as never, now: NOW }))
        .totalNewContacts
    ).toBe(0);
  });

  it("throws on a read error and defaults the client/now when omitted", async () => {
    const down = mockDb({ data: null, error: { message: "down" } });
    await expect(
      getLeadSourceOverview("biz-1", { client: down.db as never })
    ).rejects.toThrow("getLeadSourceOverview: down");

    const ok = mockDb({ data: [row()], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.db as never);
    expect((await getLeadSourceOverview("biz-1")).totalNewContacts).toBe(1);
  });
});
