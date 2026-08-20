import { describe, expect, it, vi, beforeEach } from "vitest";

// Pin CENTRAL residency mode. `contacts` is a residency-moved table, so this
// module routes its scan through the residency layer; the VPS branch is
// covered by tests/residency-read-flip.test.ts.
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false) };
});

import {
  DEALS_ANALYTICS_SCAN_LIMIT,
  DEALS_ANALYTICS_WINDOW_DAYS,
  DEALS_CONTACT_CHUNK,
  DEALS_NO_SOURCE_LABEL,
  DEALS_UNASSIGNED_LABEL,
  buildDealsOverview,
  getDealsOverview,
  type DealContactFacts,
  type WonDealRow
} from "@/lib/analytics/deals";
import { analyticsWindowStart } from "@/lib/analytics/dashboard-analytics";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/employees", () => ({
  listTeamMembers: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listTeamMembers } from "@/lib/db/employees";

type Result = { data: unknown; error: unknown; count?: number | null };

function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "order", "limit"]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (
    resolve: (v: Result) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<Result>;
}

function mockDb(queue: Result[]) {
  const remaining = [...queue];
  const chains: ReturnType<typeof chain>[] = [];
  const from = vi.fn(() => {
    const result =
      remaining.length > 1
        ? remaining.shift()!
        : remaining[0] ?? { data: null, error: { message: "no mock" } };
    const c = chain(result);
    chains.push(c);
    return c;
  });
  return { from, chains };
}

const MEMBERS = [
  { id: "emp-1", name: "Alice" },
  { id: "emp-2", name: "Bob" }
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTeamMembers).mockResolvedValue(MEMBERS as never);
});

describe("buildDealsOverview", () => {
  it("groups won money by lead source and by owning teammate", () => {
    const contacts: DealContactFacts[] = [
      { id: "c1", lead_source: "Zillow", owner_employee_id: "emp-1" },
      { id: "c2", lead_source: "zillow", owner_employee_id: "emp-1" },
      { id: "c3", lead_source: "Referral", owner_employee_id: "emp-gone" },
      { id: "c4", lead_source: null, owner_employee_id: null }
    ];
    const overview = buildDealsOverview({
      createdCount: 7,
      wonDeals: [
        { contact_id: "c1", value_cents: 100000 },
        { contact_id: "c2", value_cents: 50000 },
        { contact_id: "c3", value_cents: 200000 },
        { contact_id: "c4", value_cents: null }
      ],
      openDeals: [{ value_cents: 30000 }, { value_cents: null }],
      contacts,
      members: MEMBERS,
      windowDays: 30,
      clipped: false
    });

    expect(overview.createdCount).toBe(7);
    expect(overview.wonCount).toBe(4);
    expect(overview.wonValueCents).toBe(350000);
    expect(overview.openCount).toBe(2);
    expect(overview.openValueCents).toBe(30000);
    // Case-insensitive source fold under the first-seen casing; a null
    // lead_source stays visible as its own bucket.
    expect(overview.bySource).toEqual([
      { label: "Referral", wonCount: 1, wonValueCents: 200000 },
      { label: "Zillow", wonCount: 2, wonValueCents: 150000 },
      { label: DEALS_NO_SOURCE_LABEL, wonCount: 1, wonValueCents: 0 }
    ]);
    // A removed roster row still closed a deal; an unowned contact stays
    // visible as Unassigned.
    expect(overview.byOwner).toEqual([
      { employeeId: "emp-gone", name: "Former teammate", wonCount: 1, wonValueCents: 200000 },
      { employeeId: "emp-1", name: "Alice", wonCount: 2, wonValueCents: 150000 },
      { employeeId: null, name: DEALS_UNASSIGNED_LABEL, wonCount: 1, wonValueCents: 0 }
    ]);
    expect(overview.clipped).toBe(false);
  });

  it("a contactless or unmatched deal falls into the no-source bucket", () => {
    const overview = buildDealsOverview({
      createdCount: 0,
      wonDeals: [
        { contact_id: null, value_cents: 100 },
        { contact_id: "c-unknown", value_cents: 200 },
        // Whitespace-only lead_source is no signal.
        { contact_id: "c-blank", value_cents: 300 }
      ],
      openDeals: [],
      contacts: [{ id: "c-blank", lead_source: "   ", owner_employee_id: null }],
      members: [],
      windowDays: 30,
      clipped: true
    });
    expect(overview.bySource).toEqual([
      { label: DEALS_NO_SOURCE_LABEL, wonCount: 3, wonValueCents: 600 }
    ]);
    expect(overview.byOwner).toEqual([
      { employeeId: null, name: DEALS_UNASSIGNED_LABEL, wonCount: 3, wonValueCents: 600 }
    ]);
    expect(overview.clipped).toBe(true);
  });

  it("sorts by won value, then won count on a money tie", () => {
    const overview = buildDealsOverview({
      createdCount: 0,
      wonDeals: [
        { contact_id: "a", value_cents: 300 },
        { contact_id: "b1", value_cents: 50 },
        { contact_id: "b2", value_cents: 50 }
      ],
      openDeals: [],
      contacts: [
        { id: "a", lead_source: "Solo", owner_employee_id: null },
        { id: "b1", lead_source: "Pair", owner_employee_id: null },
        { id: "b2", lead_source: "Pair", owner_employee_id: null }
      ],
      members: [],
      windowDays: 30,
      clipped: false
    });
    expect(overview.bySource.map((r) => r.label)).toEqual(["Solo", "Pair"]);

    const tie = buildDealsOverview({
      createdCount: 0,
      wonDeals: [
        { contact_id: "one", value_cents: 100 },
        { contact_id: "two1", value_cents: 50 },
        { contact_id: "two2", value_cents: 50 }
      ],
      openDeals: [],
      contacts: [
        { id: "one", lead_source: "One big", owner_employee_id: null },
        { id: "two1", lead_source: "Two small", owner_employee_id: null },
        { id: "two2", lead_source: "Two small", owner_employee_id: null }
      ],
      members: [],
      windowDays: 30,
      clipped: false
    });
    // 100 = 50 + 50: the tie breaks toward more deals won.
    expect(tie.bySource.map((r) => r.label)).toEqual(["Two small", "One big"]);
  });
});

describe("getDealsOverview", () => {
  const NOW = new Date("2026-08-20T15:00:00.000Z");
  const SINCE = analyticsWindowStart(NOW, DEALS_ANALYTICS_WINDOW_DAYS).toISOString();

  it("scans created/won/open plus the won contacts and folds the overview", async () => {
    const db = mockDb([
      { data: null, error: null, count: 5 },
      { data: [{ contact_id: "c1", value_cents: 1000 }], error: null },
      { data: [{ value_cents: 500 }], error: null },
      {
        data: [{ id: "c1", lead_source: "Zillow", owner_employee_id: "emp-1" }],
        error: null
      }
    ]);
    const overview = await getDealsOverview("biz-1", { client: db as never, now: NOW });
    expect(overview.createdCount).toBe(5);
    expect(overview.wonCount).toBe(1);
    expect(overview.wonValueCents).toBe(1000);
    expect(overview.openCount).toBe(1);
    expect(overview.openValueCents).toBe(500);
    expect(overview.bySource).toEqual([{ label: "Zillow", wonCount: 1, wonValueCents: 1000 }]);
    expect(overview.byOwner).toEqual([
      { employeeId: "emp-1", name: "Alice", wonCount: 1, wonValueCents: 1000 }
    ]);
    expect(overview.windowDays).toBe(DEALS_ANALYTICS_WINDOW_DAYS);
    expect(overview.clipped).toBe(false);
    // Window alignment: both the created count and the won scan share the
    // UTC day-aligned start every other analytics card uses.
    expect(db.chains[0].gte).toHaveBeenCalledWith("created_at", SINCE);
    expect(db.chains[1].gte).toHaveBeenCalledWith("won_at", SINCE);
    expect(db.chains[2].in).toHaveBeenCalledWith("status", ["open", "under_contract"]);
    expect(listTeamMembers).toHaveBeenCalledWith("biz-1", db);
  });

  it("chunks the contact lookup and dedupes repeated contact ids", async () => {
    const wonDeals: WonDealRow[] = [];
    for (let i = 0; i < DEALS_CONTACT_CHUNK + 1; i += 1) {
      wonDeals.push({ contact_id: `c${i}`, value_cents: 1 });
      wonDeals.push({ contact_id: `c${i}`, value_cents: 1 });
    }
    wonDeals.push({ contact_id: null, value_cents: 1 });
    const db = mockDb([
      { data: null, error: null, count: 0 },
      { data: wonDeals, error: null },
      { data: [], error: null },
      { data: [], error: null }, // chunk 1
      { data: null, error: null } // chunk 2 (null page tolerated)
    ]);
    const overview = await getDealsOverview("biz-1", { client: db as never, now: NOW });
    expect(db.from).toHaveBeenCalledTimes(5);
    expect(db.chains[3].in.mock.calls[0][1]).toHaveLength(DEALS_CONTACT_CHUNK);
    expect(db.chains[4].in.mock.calls[0][1]).toHaveLength(1);
    expect(overview.wonCount).toBe(wonDeals.length);
  });

  it("skips the contact lookup when nothing was won, honoring a custom window", async () => {
    const db = mockDb([
      { data: null, error: null, count: null },
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const overview = await getDealsOverview("biz-1", {
      client: db as never,
      now: NOW,
      windowDays: 7
    });
    expect(db.from).toHaveBeenCalledTimes(3);
    expect(overview.createdCount).toBe(0);
    expect(overview.wonCount).toBe(0);
    expect(overview.openCount).toBe(0);
    expect(overview.windowDays).toBe(7);
    expect(db.chains[0].gte).toHaveBeenCalledWith(
      "created_at",
      analyticsWindowStart(NOW, 7).toISOString()
    );
  });

  it("flags a clipped scan on either the won or the open leg", async () => {
    const filled = Array.from({ length: DEALS_ANALYTICS_SCAN_LIMIT }, () => ({
      contact_id: null,
      value_cents: 1
    }));
    const wonFull = mockDb([
      { data: null, error: null, count: 1 },
      { data: filled, error: null },
      { data: [], error: null }
    ]);
    expect(
      (await getDealsOverview("biz-1", { client: wonFull as never, now: NOW })).clipped
    ).toBe(true);

    const openFull = mockDb([
      { data: null, error: null, count: 1 },
      { data: [], error: null },
      { data: filled.map(({ value_cents }) => ({ value_cents })), error: null }
    ]);
    expect(
      (await getDealsOverview("biz-1", { client: openFull as never, now: NOW })).clipped
    ).toBe(true);
  });

  it("throws distinctly on each failing leg", async () => {
    const created = mockDb([
      { data: null, error: { message: "down" } },
      { data: [], error: null },
      { data: [], error: null }
    ]);
    await expect(getDealsOverview("biz-1", { client: created as never })).rejects.toThrow(
      "getDealsOverview: created: down"
    );

    const won = mockDb([
      { data: null, error: null, count: 0 },
      { data: null, error: { message: "down" } },
      { data: [], error: null }
    ]);
    await expect(getDealsOverview("biz-1", { client: won as never })).rejects.toThrow(
      "getDealsOverview: won: down"
    );

    const open = mockDb([
      { data: null, error: null, count: 0 },
      { data: [], error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(getDealsOverview("biz-1", { client: open as never })).rejects.toThrow(
      "getDealsOverview: open: down"
    );

    const contacts = mockDb([
      { data: null, error: null, count: 0 },
      { data: [{ contact_id: "c1", value_cents: 1 }], error: null },
      { data: [], error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(getDealsOverview("biz-1", { client: contacts as never })).rejects.toThrow(
      "getDealsOverview: contacts: down"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([
      { data: null, error: null, count: 0 },
      { data: [], error: null },
      { data: [], error: null }
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const overview = await getDealsOverview("biz-1");
    expect(overview.createdCount).toBe(0);
  });
});
