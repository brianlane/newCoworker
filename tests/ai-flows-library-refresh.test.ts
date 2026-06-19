import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/ai-flows/library", () => ({
  aggregateLibraryCandidates: vi.fn(),
  upsertLibraryEntry: vi.fn(),
  pruneLibraryEntries: vi.fn()
}));
// Wrap the real scrub module so scrubbing/redaction stay real, but the PII gate
// can be forced on for the skip-branch test (a real scrub never leaves PII).
vi.mock("@/lib/ai-flows/scrub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-flows/scrub")>();
  return { ...actual, containsLikelyPii: vi.fn(actual.containsLikelyPii) };
});

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  aggregateLibraryCandidates,
  pruneLibraryEntries,
  upsertLibraryEntry
} from "@/lib/ai-flows/library";
import { containsLikelyPii } from "@/lib/ai-flows/scrub";
import { refreshAiFlowLibrary } from "@/lib/ai-flows/library-refresh";

const DEF = {
  version: 1,
  trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
  steps: [{ id: "s1", type: "send_sms", to: "+15826866672", body: "hi from Amy" }]
};

function candidate(over: Record<string, unknown> = {}) {
  return {
    flow_id: "f1",
    business_id: "biz-1",
    name: "ReferralExchange lead",
    definition: DEF,
    business_type: "real_estate",
    done_count: 3,
    total_count: 5,
    done_last_7d: 2,
    last_done_at: "2026-06-10T00:00:00Z",
    ...over
  };
}

// A db whose from(table) resolves table-specific rows for loadKnownNames's
// businesses + ai_flow_team_members selects.
function makeNamesDb(tables: Record<string, unknown[]>) {
  const from = vi.fn((table: string) => {
    const b: any = {};
    b.select = vi.fn(() => b);
    b.in = vi.fn(() => b);
    b.then = (resolve: any, reject: any) =>
      // Absent tables resolve null data so loadKnownNames's `?? []` is exercised.
      Promise.resolve({ data: tables[table] ?? null, error: null }).then(resolve, reject);
    return b;
  });
  return { from } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("refreshAiFlowLibrary", () => {
  it("returns zero counts and skips name lookups when there are no candidates", async () => {
    vi.mocked(aggregateLibraryCandidates).mockResolvedValue([]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(makeNamesDb({}));
    const result = await refreshAiFlowLibrary();
    expect(result).toEqual({ candidates: 0, groups: 0, published: 0, skipped: 0 });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(upsertLibraryEntry).not.toHaveBeenCalled();
    // With no candidates, prune clears the whole catalog (empty keep list).
    expect(pruneLibraryEntries).toHaveBeenCalledWith([], expect.anything());
  });

  it("groups copies, sums stats, scrubs names, and upserts one entry per template", async () => {
    vi.mocked(aggregateLibraryCandidates).mockResolvedValue([
      // Null last_done_at here exercises the representative reduce's `?? ""`.
      candidate({ business_id: "biz-1", last_done_at: null }),
      // Same template (copy suffix) from another business, more recent -> rep.
      // real_estate exercises the mapped-category branch.
      candidate({
        flow_id: "f2",
        business_id: "biz-2",
        name: "ReferralExchange lead (copy)",
        last_done_at: "2026-06-15T00:00:00Z",
        done_count: 4,
        total_count: 4,
        done_last_7d: 1,
        business_type: "real_estate"
      }),
      // A second copy from biz-1 (also null) so the reduce compares null vs null
      // and null-as-candidate; adds nothing to the sums.
      candidate({
        flow_id: "f6",
        business_id: "biz-1",
        name: "ReferralExchange lead",
        last_done_at: null,
        done_count: 0,
        total_count: 0,
        done_last_7d: 0
      }),
      // Different template, null business_type and null last_done_at -> General.
      candidate({
        flow_id: "f3",
        business_id: "biz-3",
        name: "Daily digest",
        business_type: null,
        last_done_at: null,
        done_count: 1,
        total_count: 1,
        done_last_7d: 0
      }),
      // Unmapped business_type -> title-cased default-category branch.
      candidate({
        flow_id: "f5",
        business_id: "biz-5",
        name: "Weekly report",
        business_type: "unknown_industry"
      }),
      // Name that slugs to empty -> skipped.
      candidate({ flow_id: "f4", business_id: "biz-4", name: "!!!" })
    ] as never);

    const db = makeNamesDb({
      businesses: [
        // Business name tokens ("Amy"/"Laidlaw") feed title redaction; the
        // generic suffix ("Real Estate") is dropped so titles keep common nouns.
        { id: "biz-2", owner_name: "Amy", name: "Amy Laidlaw Real Estate" },
        { id: "biz-1", owner_name: null, name: null },
        { id: "biz-3", owner_name: "X" } // 1-char -> skipped
      ],
      ai_flow_team_members: [{ business_id: "biz-2", name: "Jordan" }]
    });

    const result = await refreshAiFlowLibrary(db);

    expect(result.candidates).toBe(6);
    // referralexchange-lead + daily-digest + weekly-report ("!!!" is dropped).
    expect(result.groups).toBe(3);
    expect(result.published).toBe(3);
    expect(result.skipped).toBe(0);

    const calls = vi.mocked(upsertLibraryEntry).mock.calls.map((c) => c[0]);
    const ref = calls.find((c) => c.templateKey === "referralexchange-lead")!;
    expect(ref.title).toBe("ReferralExchange lead");
    expect(ref.totalSuccessfulRuns).toBe(7); // 3 + 4
    expect(ref.totalRuns).toBe(9); // 5 + 4
    expect(ref.runsLast7d).toBe(3); // 2 + 1
    expect(ref.businessesUsing).toBe(2);
    expect(ref.lastRunAt).toBe("2026-06-15T00:00:00Z");
    // Representative is biz-2's copy; "Amy" (owner) is redacted from the body.
    expect(JSON.stringify(ref.scrubbedDefinition)).not.toContain("Amy");
    // real_estate -> mapped category.
    expect(ref.category).toBe("Real estate");

    const digest = calls.find((c) => c.templateKey === "daily-digest")!;
    expect(digest.category).toBe("General"); // null business_type
    expect(digest.lastRunAt).toBeNull();

    const weekly = calls.find((c) => c.templateKey === "weekly-report")!;
    expect(weekly.category).toBe("Unknown Industry"); // unmapped -> title-cased

    // Stale entries are pruned to the surviving template keys.
    expect(pruneLibraryEntries).toHaveBeenCalledTimes(1);
    const keptKeys = vi.mocked(pruneLibraryEntries).mock.calls[0][0];
    expect([...keptKeys].sort()).toEqual(["daily-digest", "referralexchange-lead", "weekly-report"]);
  });

  it("handles null name-lookup results (no known names)", async () => {
    vi.mocked(aggregateLibraryCandidates).mockResolvedValue([candidate()] as never);
    const result = await refreshAiFlowLibrary(makeNamesDb({}));
    expect(result).toEqual({ candidates: 1, groups: 1, published: 1, skipped: 0 });
    expect(upsertLibraryEntry).toHaveBeenCalledTimes(1);
  });

  it("withholds a template that still trips the PII gate", async () => {
    vi.mocked(aggregateLibraryCandidates).mockResolvedValue([candidate()] as never);
    vi.mocked(containsLikelyPii).mockReturnValue(true);
    const result = await refreshAiFlowLibrary(makeNamesDb({}));
    expect(result).toEqual({ candidates: 1, groups: 1, published: 0, skipped: 1 });
    expect(upsertLibraryEntry).not.toHaveBeenCalled();
    // Nothing published -> prune clears the catalog.
    expect(pruneLibraryEntries).toHaveBeenCalledWith([], expect.anything());
  });
});
