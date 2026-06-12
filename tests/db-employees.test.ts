import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

/**
 * Coverage for src/lib/db/employees.ts — the Employees page data layer.
 *
 * Same philosophy as tests/customer-memory-db.test.ts: pin the wire-level
 * shape sent to PostgREST (tables, column lists, filters) with a chainable
 * mock, and exercise the pure aggregateRoutingStats logic directly.
 */

import {
  ROUTING_STATS_RUN_LIMIT,
  addTimeOff,
  aggregateRoutingStats,
  createTeamMember,
  deleteTeamMember,
  deleteTimeOff,
  listEmployeeRoutingStats,
  listTeamMembers,
  listTimeOff,
  updateTeamMember,
  type TeamMemberRow,
  type TimeOffRow
} from "../src/lib/db/employees";
import { createSupabaseServiceClient } from "../src/lib/supabase/server";

const BIZ = "00000000-0000-0000-0000-000000000001";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000aa";
const PHONE = "+14805551234";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function memberRow(overrides: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: MEMBER_ID,
    business_id: BIZ,
    name: "Gabby",
    phone_e164: PHONE,
    email: null,
    active: true,
    last_offered_at: null,
    weekly_schedule: null,
    preferred_windows: null,
    created_at: "2026-06-01T00:00:00Z",
    ...overrides
  };
}

function timeOffRow(overrides: Partial<TimeOffRow> = {}): TimeOffRow {
  return {
    id: "00000000-0000-0000-0000-0000000000bb",
    business_id: BIZ,
    member_id: MEMBER_ID,
    starts_on: "2026-06-12",
    ends_on: "2026-06-14",
    note: null,
    created_at: "2026-06-01T00:00:00Z",
    ...overrides
  };
}

type CallLog = { name: string; args: unknown[] };

function makeClient(terminator: { data?: unknown; error?: unknown }) {
  const fromCalls: Array<{ table: string; calls: CallLog[] }> = [];
  const client = {
    from(table: string) {
      const calls: CallLog[] = [];
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "delete", "eq", "not", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          calls.push({ name: m, args });
          return builder;
        };
      }
      builder["single"] = async () => {
        calls.push({ name: "single", args: [] });
        return terminator;
      };
      builder["maybeSingle"] = async () => {
        calls.push({ name: "maybeSingle", args: [] });
        return terminator;
      };
      builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(terminator).then(resolve, reject);
      fromCalls.push({ table, calls });
      return builder;
    }
  } as unknown as Parameters<typeof listTeamMembers>[1];
  return { client, fromCalls };
}

describe("listTeamMembers", () => {
  it("selects the pinned column list from ai_flow_team_members ordered by created_at", async () => {
    const rows = [memberRow()];
    const { client, fromCalls } = makeClient({ data: rows, error: null });
    expect(await listTeamMembers(BIZ, client)).toEqual(rows);
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("ai_flow_team_members");
    const select = String(fr.calls.find((c) => c.name === "select")?.args[0]);
    for (const col of ["email", "weekly_schedule", "preferred_windows", "last_offered_at"]) {
      expect(select).toContain(col);
    }
    expect(fr.calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(fr.calls.find((c) => c.name === "order")?.args).toEqual([
      "created_at",
      { ascending: true }
    ]);
  });

  it("returns [] on null data and falls back to the default client", async () => {
    const { client } = makeClient({ data: null, error: null });
    defaultClientSpy.mockReturnValue(client);
    expect(await listTeamMembers(BIZ)).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on PostgREST error", async () => {
    const { client } = makeClient({ data: null, error: { message: "rls" } });
    await expect(listTeamMembers(BIZ, client)).rejects.toThrow(/listTeamMembers: rls/);
  });
});

describe("createTeamMember", () => {
  it("inserts the row with optional fields defaulted to null", async () => {
    const created = memberRow();
    const { client, fromCalls } = makeClient({ data: created, error: null });
    const result = await createTeamMember(BIZ, { name: "Gabby", phoneE164: PHONE }, client);
    expect(result).toEqual(created);
    const insert = fromCalls[0]!.calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toEqual({
      business_id: BIZ,
      name: "Gabby",
      phone_e164: PHONE,
      email: null,
      weekly_schedule: null,
      preferred_windows: null
    });
    expect(fromCalls[0]!.calls.find((c) => c.name === "single")).toBeDefined();
  });

  it("passes through email and schedule values when provided, using the default client", async () => {
    const { client, fromCalls } = makeClient({ data: memberRow(), error: null });
    defaultClientSpy.mockReturnValue(client);
    await createTeamMember(BIZ, {
      name: "Gabby",
      phoneE164: PHONE,
      email: "g@x.com",
      weeklySchedule: { mon: [["09:00", "17:00"]] },
      preferredWindows: { mon: [["09:00", "12:00"]] }
    });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(fromCalls[0]!.calls.find((c) => c.name === "insert")?.args[0]).toMatchObject({
      email: "g@x.com",
      weekly_schedule: { mon: [["09:00", "17:00"]] },
      preferred_windows: { mon: [["09:00", "12:00"]] }
    });
  });

  it("throws on PostgREST error (e.g. duplicate phone)", async () => {
    const { client } = makeClient({ data: null, error: { message: "duplicate key" } });
    await expect(createTeamMember(BIZ, { name: "G", phoneE164: PHONE }, client)).rejects.toThrow(
      /createTeamMember: duplicate key/
    );
  });
});

describe("updateTeamMember", () => {
  it("maps only the provided camelCase fields to columns, scoped to (business, id)", async () => {
    const updated = memberRow({ name: "Gabrielle" });
    const { client, fromCalls } = makeClient({ data: updated, error: null });
    const result = await updateTeamMember(BIZ, MEMBER_ID, { name: "Gabrielle", active: false }, client);
    expect(result).toEqual(updated);
    const update = fromCalls[0]!.calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ name: "Gabrielle", active: false });
    const eqs = fromCalls[0]!.calls.filter((c) => c.name === "eq");
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["id", MEMBER_ID]);
  });

  it("writes schedule fields when present — including explicit null to clear them", async () => {
    const { client, fromCalls } = makeClient({ data: memberRow(), error: null });
    await updateTeamMember(
      BIZ,
      MEMBER_ID,
      {
        phoneE164: "+14805559999",
        email: null,
        weeklySchedule: null,
        preferredWindows: { tue: [["10:00", "12:00"]] }
      },
      client
    );
    expect(fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0]).toEqual({
      phone_e164: "+14805559999",
      email: null,
      weekly_schedule: null,
      preferred_windows: { tue: [["10:00", "12:00"]] }
    });
  });

  it("writes a non-null weekly schedule and clears preferred windows in one patch", async () => {
    const { client, fromCalls } = makeClient({ data: memberRow(), error: null });
    await updateTeamMember(
      BIZ,
      MEMBER_ID,
      { weeklySchedule: { mon: [["09:00", "17:00"]] }, preferredWindows: null },
      client
    );
    expect(fromCalls[0]!.calls.find((c) => c.name === "update")?.args[0]).toEqual({
      weekly_schedule: { mon: [["09:00", "17:00"]] },
      preferred_windows: null
    });
  });

  it("returns null when no row matched (deleted in another tab) and supports the default client", async () => {
    const { client } = makeClient({ data: null, error: null });
    defaultClientSpy.mockReturnValue(client);
    expect(await updateTeamMember(BIZ, MEMBER_ID, { name: "X" })).toBeNull();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on PostgREST error", async () => {
    const { client } = makeClient({ data: null, error: { message: "rls" } });
    await expect(updateTeamMember(BIZ, MEMBER_ID, { name: "X" }, client)).rejects.toThrow(
      /updateTeamMember: rls/
    );
  });
});

describe("deleteTeamMember", () => {
  it("DELETEs scoped to (business_id, id)", async () => {
    const { client, fromCalls } = makeClient({ data: null, error: null });
    await deleteTeamMember(BIZ, MEMBER_ID, client);
    const fr = fromCalls[0]!;
    expect(fr.calls.find((c) => c.name === "delete")).toBeDefined();
    const eqs = fr.calls.filter((c) => c.name === "eq");
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["id", MEMBER_ID]);
  });

  it("falls back to the default client and throws on error", async () => {
    const { client } = makeClient({ data: null, error: { message: "fk" } });
    defaultClientSpy.mockReturnValue(client);
    await expect(deleteTeamMember(BIZ, MEMBER_ID)).rejects.toThrow(/deleteTeamMember: fk/);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listTimeOff", () => {
  it("selects time-off rows for the business ordered by starts_on", async () => {
    const rows = [timeOffRow()];
    const { client, fromCalls } = makeClient({ data: rows, error: null });
    expect(await listTimeOff(BIZ, client)).toEqual(rows);
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("employee_time_off");
    expect(fr.calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(fr.calls.find((c) => c.name === "order")?.args).toEqual([
      "starts_on",
      { ascending: true }
    ]);
  });

  it("returns [] on null data with the default client", async () => {
    const { client } = makeClient({ data: null, error: null });
    defaultClientSpy.mockReturnValue(client);
    expect(await listTimeOff(BIZ)).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on PostgREST error", async () => {
    const { client } = makeClient({ data: null, error: { message: "boom" } });
    await expect(listTimeOff(BIZ, client)).rejects.toThrow(/listTimeOff: boom/);
  });
});

describe("addTimeOff", () => {
  it("inserts the range with note defaulted to null", async () => {
    const created = timeOffRow();
    const { client, fromCalls } = makeClient({ data: created, error: null });
    const result = await addTimeOff(
      BIZ,
      { memberId: MEMBER_ID, startsOn: "2026-06-12", endsOn: "2026-06-14" },
      client
    );
    expect(result).toEqual(created);
    expect(fromCalls[0]!.calls.find((c) => c.name === "insert")?.args[0]).toEqual({
      business_id: BIZ,
      member_id: MEMBER_ID,
      starts_on: "2026-06-12",
      ends_on: "2026-06-14",
      note: null
    });
  });

  it("passes the note through with the default client", async () => {
    const { client, fromCalls } = makeClient({ data: timeOffRow({ note: "vacation" }), error: null });
    defaultClientSpy.mockReturnValue(client);
    await addTimeOff(BIZ, {
      memberId: MEMBER_ID,
      startsOn: "2026-06-12",
      endsOn: "2026-06-14",
      note: "vacation"
    });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(fromCalls[0]!.calls.find((c) => c.name === "insert")?.args[0]).toMatchObject({
      note: "vacation"
    });
  });

  it("throws on PostgREST error (e.g. range check violation)", async () => {
    const { client } = makeClient({ data: null, error: { message: "check constraint" } });
    await expect(
      addTimeOff(BIZ, { memberId: MEMBER_ID, startsOn: "2026-06-14", endsOn: "2026-06-12" }, client)
    ).rejects.toThrow(/addTimeOff: check constraint/);
  });
});

describe("deleteTimeOff", () => {
  it("DELETEs scoped to (business_id, id)", async () => {
    const { client, fromCalls } = makeClient({ data: null, error: null });
    await deleteTimeOff(BIZ, "too-1", client);
    const eqs = fromCalls[0]!.calls.filter((c) => c.name === "eq");
    expect(eqs[0]?.args).toEqual(["business_id", BIZ]);
    expect(eqs[1]?.args).toEqual(["id", "too-1"]);
  });

  it("falls back to the default client and throws on error", async () => {
    const { client } = makeClient({ data: null, error: { message: "rls" } });
    defaultClientSpy.mockReturnValue(client);
    await expect(deleteTimeOff(BIZ, "too-1")).rejects.toThrow(/deleteTimeOff: rls/);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("aggregateRoutingStats", () => {
  const OTHER = "+14805550000";

  it("counts offers from tried[], the live offered phone, and claims (claimed_by)", () => {
    const stats = aggregateRoutingStats([
      {
        created_at: "2026-06-10T00:00:00Z",
        context: { routing: { tried: [PHONE, OTHER], offered: "+14805551111" } }
      },
      {
        created_at: "2026-06-11T00:00:00Z",
        context: { routing: { tried: [OTHER], claimed_by: PHONE } }
      }
    ]);
    // Run 1: PHONE rejected (tried). Run 2: PHONE claimed (claimed_by only —
    // a claim never lands in tried[], which is exactly why it must still
    // count as an offer).
    expect(stats[PHONE]).toEqual({
      offered: 2,
      claimed: 1,
      lastOfferedAt: "2026-06-11T00:00:00Z",
      lastClaimedAt: "2026-06-11T00:00:00Z"
    });
    expect(stats[OTHER]).toEqual({
      offered: 2,
      claimed: 0,
      lastOfferedAt: "2026-06-11T00:00:00Z",
      lastClaimedAt: null
    });
    expect(stats["+14805551111"]).toEqual({
      offered: 1,
      claimed: 0,
      lastOfferedAt: "2026-06-10T00:00:00Z",
      lastClaimedAt: null
    });
  });

  it("counts a phone once per run even when it appears in tried AND claimed_by", () => {
    const stats = aggregateRoutingStats([
      {
        created_at: "2026-06-10T00:00:00Z",
        context: { routing: { tried: [PHONE, PHONE], claimed_by: PHONE } }
      }
    ]);
    expect(stats[PHONE]).toEqual({
      offered: 1,
      claimed: 1,
      lastOfferedAt: "2026-06-10T00:00:00Z",
      lastClaimedAt: "2026-06-10T00:00:00Z"
    });
  });

  it("keeps the newest timestamp regardless of input order", () => {
    const stats = aggregateRoutingStats([
      { created_at: "2026-06-11T00:00:00Z", context: { routing: { tried: [PHONE] } } },
      { created_at: "2026-06-09T00:00:00Z", context: { routing: { tried: [PHONE] } } }
    ]);
    expect(stats[PHONE]?.offered).toBe(2);
    expect(stats[PHONE]?.lastOfferedAt).toBe("2026-06-11T00:00:00Z");
  });

  it("skips runs with missing/malformed contexts and non-string routing fields", () => {
    const stats = aggregateRoutingStats([
      { created_at: "2026-06-10T00:00:00Z", context: null },
      { created_at: "2026-06-10T00:00:00Z", context: "string" },
      { created_at: "2026-06-10T00:00:00Z", context: {} },
      { created_at: "2026-06-10T00:00:00Z", context: { routing: "claimed" } },
      {
        created_at: "2026-06-10T00:00:00Z",
        context: { routing: { tried: [42, ""], offered: 7, claimed_by: "" } }
      }
    ]);
    expect(stats).toEqual({});
  });
});

describe("listEmployeeRoutingStats", () => {
  it("queries recent runs that have routing context and aggregates them", async () => {
    const { client, fromCalls } = makeClient({
      data: [
        {
          created_at: "2026-06-10T00:00:00Z",
          context: { routing: { claimed_by: PHONE } }
        }
      ],
      error: null
    });
    const stats = await listEmployeeRoutingStats(BIZ, client);
    expect(stats[PHONE]?.claimed).toBe(1);
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("ai_flow_runs");
    expect(fr.calls.find((c) => c.name === "not")?.args).toEqual([
      "context->routing",
      "is",
      null
    ]);
    expect(fr.calls.find((c) => c.name === "order")?.args).toEqual([
      "created_at",
      { ascending: false }
    ]);
    expect(fr.calls.find((c) => c.name === "limit")?.args).toEqual([ROUTING_STATS_RUN_LIMIT]);
  });

  it("returns {} on null data with the default client", async () => {
    const { client } = makeClient({ data: null, error: null });
    defaultClientSpy.mockReturnValue(client);
    expect(await listEmployeeRoutingStats(BIZ)).toEqual({});
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("throws on PostgREST error", async () => {
    const { client } = makeClient({ data: null, error: { message: "boom" } });
    await expect(listEmployeeRoutingStats(BIZ, client)).rejects.toThrow(
      /listEmployeeRoutingStats: boom/
    );
  });
});
