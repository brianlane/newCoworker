import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  MAX_DUPLICATE_PAIRS,
  contactCompletenessScore,
  findDuplicateContactPairs,
  pickCanonicalContact,
  type ScorableContact
} from "@/lib/customer-memory/dedup";

const NOW = new Date("2026-07-10T00:00:00.000Z");
const BIZ = "biz-1";

function contact(overrides: Partial<ScorableContact> = {}): ScorableContact {
  return {
    customer_e164: "+15550001111",
    display_name: null,
    name_source: "auto",
    email: null,
    summary_md: null,
    pinned_md: null,
    tags: [],
    birthday: null,
    total_interaction_count: 0,
    last_interaction_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("contactCompletenessScore", () => {
  it("scores an empty profile 0 and a full profile on every axis", () => {
    expect(contactCompletenessScore(contact(), NOW)).toBe(0);
    const full = contact({
      display_name: "Jane Doe",
      name_source: "manual",
      email: "jane@example.com",
      summary_md: "Long-time customer",
      pinned_md: "VIP",
      tags: ["vip"],
      birthday: "1990-04-01",
      total_interaction_count: 100, // capped at 50 → +5
      last_interaction_at: "2026-07-01T00:00:00Z" // within 90d → +2
    });
    // 2+1 (manual name) + 2 (email) + 2 (summary) + 2 (pinned) + 1 (tags)
    // + 1 (birthday) + 5 (interactions) + 2 (recent) = 18
    expect(contactCompletenessScore(full, NOW)).toBe(18);
  });

  it("weights an auto name less than a manual one", () => {
    const auto = contact({ display_name: "Jane", name_source: "auto" });
    const manual = contact({ display_name: "Jane", name_source: "manual" });
    expect(contactCompletenessScore(manual, NOW)).toBe(
      contactCompletenessScore(auto, NOW) + 1
    );
  });

  it("grades interaction recency in bands and tolerates junk timestamps", () => {
    const recent = contact({ last_interaction_at: "2026-06-01T00:00:00Z" });
    const thisYear = contact({ last_interaction_at: "2025-09-01T00:00:00Z" });
    const ancient = contact({ last_interaction_at: "2020-01-01T00:00:00Z" });
    const junk = contact({ last_interaction_at: "not-a-date" });
    expect(contactCompletenessScore(recent, NOW)).toBe(2);
    expect(contactCompletenessScore(thisYear, NOW)).toBe(1);
    expect(contactCompletenessScore(ancient, NOW)).toBe(0);
    expect(contactCompletenessScore(junk, NOW)).toBe(0);
  });

  it("defaults `now` to the wall clock", () => {
    expect(
      contactCompletenessScore(contact({ last_interaction_at: new Date().toISOString() }))
    ).toBe(2);
  });

  it("tolerates a null tags column", () => {
    expect(contactCompletenessScore(contact({ tags: null }), NOW)).toBe(0);
  });
});

describe("pickCanonicalContact", () => {
  it("the higher completeness score survives, in either argument order", () => {
    const rich = contact({ customer_e164: "+15550002222", email: "j@x.co", pinned_md: "VIP" });
    const poor = contact({ customer_e164: "+15550003333" });
    expect(pickCanonicalContact(rich, poor, NOW)).toEqual({ into: rich, from: poor });
    expect(pickCanonicalContact(poor, rich, NOW)).toEqual({ into: rich, from: poor });
  });

  it("breaks score ties on interaction depth", () => {
    // Interaction counts of 1 vs 4 score identically (+0.1 vs +0.4 differ!).
    // Use counts that produce the same capped score: 60 and 70 both → +5.
    const a = contact({ customer_e164: "+15550002222", total_interaction_count: 60 });
    const b = contact({ customer_e164: "+15550003333", total_interaction_count: 70 });
    expect(pickCanonicalContact(a, b, NOW).into).toBe(b);
    expect(pickCanonicalContact(b, a, NOW).into).toBe(b);
  });

  it("breaks full ties toward the older row", () => {
    const older = contact({ customer_e164: "+15550002222", created_at: "2025-01-01T00:00:00Z" });
    const newer = contact({ customer_e164: "+15550003333", created_at: "2026-01-01T00:00:00Z" });
    expect(pickCanonicalContact(older, newer, NOW).into).toBe(older);
    expect(pickCanonicalContact(newer, older, NOW).into).toBe(older);
  });

  it("defaults `now` to the wall clock", () => {
    const a = contact({ customer_e164: "+15550002222" });
    const b = contact({ customer_e164: "+15550003333", email: "x@y.co" });
    expect(pickCanonicalContact(a, b).into).toBe(b);
  });
});

type ScanRow = ScorableContact;

function makeDb(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { from: vi.fn(() => chain), chain } as never;
}

describe("findDuplicateContactPairs", () => {
  const jane = (e164: string, overrides: Partial<ScanRow> = {}) =>
    contact({ customer_e164: e164, email: "Jane@Example.com", ...overrides });

  it("pairs same-email customers with the completeness winner as the survivor", async () => {
    const rich = jane("+15550001111", {
      display_name: "Jane Doe",
      pinned_md: "VIP",
      email: "jane@example.com"
    });
    const poor = jane("+15550002222");
    const unrelated = contact({ customer_e164: "+15550003333", email: "other@x.co" });
    const noEmail = contact({ customer_e164: "+15550004444", email: "  " });
    // Defensive: the query filters email IS NOT NULL, but a null slipping
    // through must not crash the grouping.
    const nullEmail = contact({ customer_e164: "+15550005555", email: null });
    const db = makeDb({ data: [poor, rich, unrelated, noEmail, nullEmail], error: null });
    const pairs = await findDuplicateContactPairs(BIZ, { client: db, now: NOW });
    expect(pairs).toEqual([
      {
        email: "jane@example.com",
        intoE164: "+15550001111",
        intoName: "Jane Doe",
        fromE164: "+15550002222",
        fromName: null
      }
    ]);
  });

  it("emails match case-insensitively and 3+ groups fold into one survivor", async () => {
    const a = jane("+15550001111", { display_name: "Jane", name_source: "manual" });
    const b = jane("+15550002222", { email: "JANE@example.com" });
    const c = jane("+15550003333", { email: "jane@EXAMPLE.com" });
    const db = makeDb({ data: [a, b, c], error: null });
    const pairs = await findDuplicateContactPairs(BIZ, { client: db, now: NOW });
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.intoE164 === "+15550001111")).toBe(true);
    expect(pairs.map((p) => p.fromE164).sort()).toEqual(["+15550002222", "+15550003333"]);
  });

  it("caps the suggestion list at MAX_DUPLICATE_PAIRS", async () => {
    const rows = Array.from({ length: 2 * (MAX_DUPLICATE_PAIRS + 3) }, (_, i) =>
      contact({
        customer_e164: `+1555000${String(i).padStart(4, "0")}`,
        email: `person${Math.floor(i / 2)}@x.co`
      })
    );
    const db = makeDb({ data: rows, error: null });
    const pairs = await findDuplicateContactPairs(BIZ, { client: db, now: NOW });
    expect(pairs).toHaveLength(MAX_DUPLICATE_PAIRS);
  });

  it("returns [] on an empty/null scan and throws on a query error", async () => {
    expect(
      await findDuplicateContactPairs(BIZ, { client: makeDb({ data: null, error: null }), now: NOW })
    ).toEqual([]);
    await expect(
      findDuplicateContactPairs(BIZ, {
        client: makeDb({ data: null, error: { message: "boom" } }),
        now: NOW
      })
    ).rejects.toThrow(/boom/);
  });

  it("uses the default service client and wall clock when not injected", async () => {
    defaultClientSpy.mockReturnValue(makeDb({ data: [], error: null }));
    expect(await findDuplicateContactPairs(BIZ)).toEqual([]);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
