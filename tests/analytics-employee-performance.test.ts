import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin CENTRAL residency mode (the transcript scan's VPS branch is covered by
// tests/residency-read-flip.test.ts).
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(async () => false) };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/employees", () => ({
  listTeamMembers: vi.fn()
}));

import {
  EMPLOYEE_RUN_SCAN_LIMIT,
  getEmployeePerformance,
  median
} from "@/lib/analytics/employee-performance";
import { listTeamMembers } from "@/lib/db/employees";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NOW = new Date("2026-07-04T12:00:00Z");
const DAVE = "+16025550001";
const ANA = "+16025550002";

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-dave",
    business_id: "biz-1",
    name: "Dave",
    phone_e164: DAVE,
    email: null,
    active: true,
    last_offered_at: null,
    weekly_schedule: null,
    preferred_windows: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

type QueryResult = { data?: unknown; error: { message: string } | null };

function makeClient(resultsByTable: Record<string, QueryResult>) {
  const chains: Record<string, unknown> = {};
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "lt", "order", "limit"]) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (onF: (v: QueryResult) => unknown) =>
      Promise.resolve(resultsByTable[table] ?? { data: [], error: null }).then(onF);
    chains[table] = chain;
    return chain;
  });
  return { client: { from } as never, chains };
}

function run(routing: Record<string, unknown> | null, createdAt: string, updatedAt: string | null) {
  return { context: routing ? { routing } : {}, created_at: createdAt, updated_at: updatedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("median", () => {
  it("handles empty, odd, and even inputs without mutating the source", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 9])).toBe(5);
    const source = [4, 2, 8, 6];
    expect(median(source)).toBe(5);
    expect(source).toEqual([4, 2, 8, 6]);
  });
});

describe("getEmployeePerformance", () => {
  it("returns [] without any reads when the roster is empty", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([]);
    const { client } = makeClient({});
    expect(await getEmployeePerformance("biz-1", { client, now: NOW })).toEqual([]);
    expect((client as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it("aggregates offers, claims, turnaround, and forwarded calls per member", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member(),
      member({ id: "m-ana", name: "Ana", phone_e164: ANA, active: false })
    ] as never);
    const { client, chains } = makeClient({
      ai_flow_runs: {
        data: [
          // Dave offered + claimed in 30 min.
          run(
            { offered_log: [DAVE], claimed_by: DAVE },
            "2026-07-01T10:00:00Z",
            "2026-07-01T10:30:00Z"
          ),
          // Both offered (Dave duplicated in the log — counted once), Ana claimed in 90 min.
          run(
            { offered_log: [DAVE, DAVE, ANA], claimed_by: ANA },
            "2026-07-02T10:00:00Z",
            "2026-07-02T11:30:00Z"
          ),
          // Dave offered, nobody claimed.
          run({ offered_log: [DAVE] }, "2026-07-03T10:00:00Z", null),
          // Claimed run with a junk updated_at: counts the claim, no duration.
          run(
            { offered_log: [DAVE], claimed_by: DAVE },
            "2026-07-03T12:00:00Z",
            "garbage"
          ),
          // Claimed run that was never updated: counts the claim, no duration.
          run({ claimed_by: DAVE }, "2026-07-03T12:30:00Z", null),
          // Claimed by someone off the roster — ignored in member rows.
          run({ claimed_by: "+19998887777" }, "2026-07-03T13:00:00Z", "2026-07-03T14:00:00Z"),
          // No routing context at all.
          run(null, "2026-07-03T15:00:00Z", null)
        ],
        error: null
      },
      voice_call_transcripts: {
        data: [
          { forwarded_to_e164: DAVE },
          { forwarded_to_e164: DAVE },
          { forwarded_to_e164: null }
        ],
        error: null
      }
    });

    const rows = await getEmployeePerformance("biz-1", { client, now: NOW, days: 30 });
    expect(rows).toEqual([
      {
        memberId: "m-dave",
        name: "Dave",
        e164: DAVE,
        active: true,
        offered: 4,
        claimed: 3,
        claimRate: 3 / 4,
        medianClaimMs: 30 * 60_000,
        forwardedCalls: 2
      },
      {
        memberId: "m-ana",
        name: "Ana",
        e164: ANA,
        active: false,
        offered: 1,
        claimed: 1,
        claimRate: 1,
        medianClaimMs: 90 * 60_000,
        forwardedCalls: 0
      }
    ]);
    const runsChain = chains.ai_flow_runs as {
      gte: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(runsChain.gte).toHaveBeenCalledWith(
      "created_at",
      new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );
    expect(runsChain.limit).toHaveBeenCalledWith(EMPLOYEE_RUN_SCAN_LIMIT);
  });

  it("sorts active members first, then by claims", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({ id: "m-inactive", name: "Iggy", phone_e164: "+16025550009", active: false }),
      member({ id: "m-quiet", name: "Quinn", phone_e164: "+16025550008" }),
      member({ id: "m-busy", name: "Busy", phone_e164: DAVE })
    ] as never);
    const { client } = makeClient({
      ai_flow_runs: {
        data: [
          run({ offered_log: [DAVE], claimed_by: DAVE }, "2026-07-01T10:00:00Z", "2026-07-01T10:05:00Z")
        ],
        error: null
      },
      voice_call_transcripts: { data: [], error: null }
    });
    const rows = await getEmployeePerformance("biz-1", { client, now: NOW });
    expect(rows.map((r) => r.memberId)).toEqual(["m-busy", "m-quiet", "m-inactive"]);
  });

  it("handles a null runs page, throws on a runs error, and defaults client/now", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
    const nullPage = makeClient({
      ai_flow_runs: { data: null, error: null },
      voice_call_transcripts: { data: [], error: null }
    });
    const rows = await getEmployeePerformance("biz-1", { client: nullPage.client, now: NOW });
    expect(rows[0]).toMatchObject({ offered: 0, claimed: 0, claimRate: null, medianClaimMs: null });

    const errPage = makeClient({
      ai_flow_runs: { data: null, error: { message: "runs down" } },
      voice_call_transcripts: { data: [], error: null }
    });
    await expect(
      getEmployeePerformance("biz-1", { client: errPage.client, now: NOW })
    ).rejects.toThrow("getEmployeePerformance runs: runs down");

    const ok = makeClient({});
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.client as never);
    expect((await getEmployeePerformance("biz-1"))[0]).toMatchObject({ offered: 0 });
  });
});
