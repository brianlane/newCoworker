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
  CLAIM_TOUCH_WINDOW_MS,
  EMPLOYEE_RUN_SCAN_LIMIT,
  TOUCH_SCAN_LIMIT,
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
  const calls: Record<string, Array<{ name: string; args: unknown[] }>> = {};
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const record = (calls[table] ??= []);
    for (const m of ["select", "eq", "neq", "is", "gte", "lt", "order", "limit", "or", "in"]) {
      chain[m] = vi.fn((...args: unknown[]) => {
        record.push({ name: m, args });
        return chain;
      });
    }
    (chain as { then: unknown }).then = (onF: (v: QueryResult) => unknown) =>
      Promise.resolve(resultsByTable[table] ?? { data: [], error: null }).then(onF);
    chains[table] = chain;
    return chain;
  });
  return { client: { from } as never, chains, calls, from };
}

function run(routing: Record<string, unknown> | null, createdAt: string, updatedAt: string | null) {
  return { context: routing ? { routing } : {}, created_at: createdAt, updated_at: updatedAt };
}

/** A run whose context also names its lead (vars.lead_phone). */
function leadRun(
  routing: Record<string, unknown>,
  leadPhone: string,
  createdAt: string,
  updatedAt: string | null
) {
  return {
    context: { routing, vars: { lead_phone: leadPhone } },
    created_at: createdAt,
    updated_at: updatedAt
  };
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
    const { client, calls, from } = makeClient({
      ai_flow_runs: {
        data: [
          // Dave offered + claimed in 30 min (legacy: no claim stamp, so
          // the duration approximates via updated_at).
          run(
            { offered_log: [DAVE], claimed_by: DAVE },
            "2026-07-01T10:00:00Z",
            "2026-07-01T10:30:00Z"
          ),
          // Both offered (Dave duplicated in the log, counted once), Ana claimed in 90 min.
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
          // A claim on a run with NO offer bookkeeping (pre-offered_log run or
          // late-claim finalization): the claim itself proves an offer reached
          // Dave, so it counts as offered too, offered can never read lower
          // than claimed. Never updated → no duration.
          run({ claimed_by: DAVE }, "2026-07-03T12:30:00Z", null),
          // A LIVE un-answered offer (routing.offered) also counts as offered.
          run({ offered: ANA }, "2026-07-03T14:00:00Z", null),
          // Claimed by someone off the roster, ignored in member rows.
          run({ claimed_by: "+19998887777" }, "2026-07-03T13:00:00Z", "2026-07-03T14:00:00Z"),
          // No routing context at all.
          run(null, "2026-07-03T15:00:00Z", null)
        ],
        error: null
      },
      voice_call_transcripts: {
        data: [
          { forwarded_to_e164: DAVE, caller_e164: null, started_at: "2026-07-01T09:00:00Z" },
          { forwarded_to_e164: DAVE, caller_e164: null, started_at: "2026-07-01T09:05:00Z" },
          { forwarded_to_e164: null, caller_e164: null, started_at: "2026-07-01T09:10:00Z" }
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
        // 4 offer-logged runs + 1 claim-implied offer = 5.
        offered: 5,
        claimed: 3,
        claimRate: 3 / 5,
        medianClaimMs: 30 * 60_000,
        medianClaimExact: false,
        claimedNoTouch48h: 0,
        forwardedCalls: 2
      },
      {
        memberId: "m-ana",
        name: "Ana",
        e164: ANA,
        active: false,
        // 1 offer-logged + 1 live routing.offered = 2.
        offered: 2,
        claimed: 1,
        claimRate: 1 / 2,
        medianClaimMs: 90 * 60_000,
        medianClaimExact: false,
        claimedNoTouch48h: 0,
        forwardedCalls: 0
      }
    ]);
    const runCalls = calls.ai_flow_runs;
    expect(runCalls).toContainEqual({
      name: "gte",
      args: ["created_at", new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()]
    });
    expect(runCalls).toContainEqual({ name: "limit", args: [EMPLOYEE_RUN_SCAN_LIMIT] });
    // None of these claims name a lead, so there is nothing to judge for
    // follow-through and the touch lookups never fire.
    expect(from).not.toHaveBeenCalledWith("contacts");
    expect(from).not.toHaveBeenCalledWith("sms_outbound_log");
    expect(from).not.toHaveBeenCalledWith("email_log");
  });

  it("uses the claim stamp for real turnaround and flags no-touch claims after the 48h grace", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member(),
      member({ id: "m-ana", name: "Ana", phone_e164: ANA })
    ] as never);
    const LEAD_A = "+14805551001"; // touched by SMS, no contact row
    const LEAD_B = "+14805551002"; // alias of a merged contact, untouched
    const LEAD_C = "+14805551003"; // touched by email (case-insensitive)
    const LEAD_D = "+14805551004"; // legacy claim, touched via its ALIAS number
    const LEAD_E = "+14805551005"; // touches exist, but before the claim / after 48h
    const LEAD_F = "+14805551006"; // claim still inside its 48h grace
    const LEAD_G = "+14805551007"; // touched by a forwarded call
    const LEAD_H = "+14805551008"; // garbage created_at, untouched
    const LEAD_I = "+14805551009"; // no usable claim time at all
    const stamp = (iso: string) => Date.parse(iso);
    const { client, calls, from } = makeClient({
      ai_flow_runs: {
        data: [
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: stamp("2026-07-01T10:20:00Z") },
            LEAD_A,
            "2026-07-01T10:00:00Z",
            "2026-07-01T11:00:00Z"
          ),
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: stamp("2026-07-01T09:00:00Z") },
            LEAD_B,
            "2026-07-01T08:30:00Z",
            null
          ),
          leadRun(
            { claimed_by: ANA, claimed_at_ms: stamp("2026-07-01T08:00:00Z") },
            LEAD_C,
            "2026-07-01T07:00:00Z",
            null
          ),
          // Legacy claim: no stamp, so the claim time approximates via
          // updated_at and the touch window opens at RUN START.
          leadRun({ claimed_by: ANA }, LEAD_D, "2026-07-01T22:00:00Z", "2026-07-02T10:00:00Z"),
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: stamp("2026-07-02T00:00:00Z") },
            LEAD_E,
            "2026-07-01T20:00:00Z",
            null
          ),
          // Claimed 30h before NOW: the 48h grace has not elapsed, so this
          // claim is pending, never judged.
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: stamp("2026-07-03T06:00:00Z") },
            LEAD_F,
            "2026-07-03T05:00:00Z",
            null
          ),
          leadRun(
            { claimed_by: ANA, claimed_at_ms: stamp("2026-07-01T00:00:00Z") },
            LEAD_G,
            "2026-06-30T23:00:00Z",
            null
          ),
          // Off-roster claimer: never judged, never a row.
          leadRun(
            { claimed_by: "+19998887777", claimed_at_ms: stamp("2026-07-01T00:00:00Z") },
            LEAD_A,
            "2026-06-30T22:00:00Z",
            null
          ),
          // Garbage created_at: no duration, and the legacy touch window
          // falls back to the claim time itself.
          leadRun({ claimed_by: DAVE }, LEAD_H, "garbage", "2026-07-01T00:00:00Z"),
          // No stamp and no updated_at: no claim time, so nothing to judge.
          leadRun({ claimed_by: DAVE }, LEAD_I, "2026-07-01T12:00:00Z", null)
        ],
        error: null
      },
      voice_call_transcripts: {
        data: [
          // Forwarded call the LEAD_G lead was on: a touch for that lead
          // (whoever answered), and a forwarded-calls tally for Dave.
          { forwarded_to_e164: DAVE, caller_e164: LEAD_G, started_at: "2026-07-01T05:00:00Z" },
          // Caller unknown: counts for Dave, touches nobody.
          { forwarded_to_e164: DAVE, caller_e164: null, started_at: "2026-07-01T06:00:00Z" },
          // Junk start time: counts for Dave, touches nobody.
          { forwarded_to_e164: DAVE, caller_e164: LEAD_G, started_at: "garbage" },
          // Not a forwarded call at all.
          { forwarded_to_e164: null, caller_e164: LEAD_A, started_at: "2026-07-01T05:00:00Z" }
        ],
        error: null
      },
      contacts: {
        data: [
          // LEAD_B arrives keyed on a merged-away alias, and its email is on
          // file but never written to, so the email check runs and clears
          // nothing.
          { customer_e164: "+14805551999", alias_e164s: [LEAD_B], email: "lead.b@example.com" },
          { customer_e164: LEAD_C, alias_e164s: null, email: "Lead.C@Example.com" },
          // Whitespace email is no email.
          { customer_e164: LEAD_D, alias_e164s: ["+14805551444"], email: " " }
        ],
        error: null
      },
      sms_outbound_log: {
        data: [
          { to_e164: LEAD_A, created_at: "2026-07-01T12:00:00Z" },
          // LEAD_D touched through its alias number, inside the legacy
          // window (after run start, before the approximate claim).
          { to_e164: "+14805551444", created_at: "2026-07-01T23:00:00Z" },
          // LEAD_E: one touch BEFORE the exact claim, one after the 48h
          // window closed; neither clears it.
          { to_e164: LEAD_E, created_at: "2026-07-01T23:00:00Z" },
          { to_e164: LEAD_E, created_at: "2026-07-04T06:00:00Z" },
          // Junk timestamp: ignored.
          { to_e164: LEAD_A, created_at: "garbage" }
        ],
        error: null
      },
      email_log: {
        data: [
          // Case-insensitive on both sides.
          { to_email: "LEAD.C@EXAMPLE.COM", created_at: "2026-07-01T10:00:00Z" },
          { to_email: null, created_at: "2026-07-01T10:00:00Z" },
          { to_email: "other@example.com", created_at: "2026-07-01T10:00:00Z" },
          { to_email: "lead.c@example.com", created_at: "garbage" }
        ],
        error: null
      }
    });

    const rows = await getEmployeePerformance("biz-1", { client, now: NOW, days: 30 });
    const dave = rows.find((r) => r.e164 === DAVE)!;
    const ana = rows.find((r) => r.e164 === ANA)!;

    // Dave's durations are all stamped: 20m (A), 30m (B), 4h (E), 1h (F).
    expect(dave.medianClaimMs).toBe(45 * 60_000);
    expect(dave.medianClaimExact).toBe(true);
    // Untouched: LEAD_B (nothing), LEAD_E (touches missed the window),
    // LEAD_H (nothing). LEAD_A was texted, LEAD_F is still pending,
    // LEAD_I has no claim time.
    expect(dave.claimedNoTouch48h).toBe(3);
    expect(dave.claimed).toBe(6);
    expect(dave.forwardedCalls).toBe(3);

    // Ana mixes a stamped hour (C), a legacy 12h approximation (D), and a
    // stamped hour (G): median 1h, but NOT exact.
    expect(ana.medianClaimMs).toBe(60 * 60_000);
    expect(ana.medianClaimExact).toBe(false);
    // C was emailed, D was texted on its alias, G was on a forwarded call.
    expect(ana.claimedNoTouch48h).toBe(0);

    // Sorting: both active, Dave's 6 claims outrank Ana's 3.
    expect(rows.map((r) => r.memberId)).toEqual(["m-dave", "m-ana"]);

    // Touch scans are precise and capped: SMS filters to the leads' numbers.
    const smsCalls = calls.sms_outbound_log;
    const inCall = smsCalls.find((c) => c.name === "in")!;
    expect(inCall.args[0]).toBe("to_e164");
    expect(inCall.args[1]).toContain(LEAD_A);
    expect(inCall.args[1]).toContain("+14805551999");
    expect(inCall.args[1]).toContain("+14805551444");
    expect(smsCalls).toContainEqual({ name: "limit", args: [TOUCH_SCAN_LIMIT] });
    expect(calls.email_log).toContainEqual({ name: "limit", args: [TOUCH_SCAN_LIMIT] });
    expect(calls.contacts.some((c) => c.name === "or")).toBe(true);
    expect(from).toHaveBeenCalledWith("email_log");
    // Sanity on the grace math the fixture leans on.
    expect(CLAIM_TOUCH_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("skips every touch lookup while all claims are inside their grace window", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
    const { client, from } = makeClient({
      ai_flow_runs: {
        data: [
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: Date.parse("2026-07-04T00:00:00Z") },
            "+14805551001",
            "2026-07-03T23:00:00Z",
            null
          )
        ],
        error: null
      },
      voice_call_transcripts: { data: [], error: null }
    });
    const rows = await getEmployeePerformance("biz-1", { client, now: NOW });
    expect(rows[0].claimedNoTouch48h).toBe(0);
    expect(from).not.toHaveBeenCalledWith("contacts");
    expect(from).not.toHaveBeenCalledWith("sms_outbound_log");
    expect(from).not.toHaveBeenCalledWith("email_log");
  });

  it("treats a null email page as zero email touches", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
    const { client } = makeClient({
      ai_flow_runs: {
        data: [
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: Date.parse("2026-07-01T00:00:00Z") },
            "+14805551001",
            "2026-06-30T23:00:00Z",
            null
          )
        ],
        error: null
      },
      voice_call_transcripts: { data: [], error: null },
      contacts: {
        data: [{ customer_e164: "+14805551001", alias_e164s: null, email: "l@x.com" }],
        error: null
      },
      email_log: { data: null, error: null }
    });
    const rows = await getEmployeePerformance("biz-1", { client, now: NOW });
    expect(rows[0].claimedNoTouch48h).toBe(1);
  });

  it("judges leads without a contact row (and without emails, the email log is never read)", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
    const { client, from } = makeClient({
      ai_flow_runs: {
        data: [
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: Date.parse("2026-07-01T00:00:00Z") },
            "+14805551001",
            "2026-06-30T23:00:00Z",
            null
          )
        ],
        error: null
      },
      voice_call_transcripts: { data: [], error: null },
      // Null pages degrade to empty, not crashes.
      contacts: { data: null, error: null },
      sms_outbound_log: { data: null, error: null }
    });
    const rows = await getEmployeePerformance("biz-1", { client, now: NOW });
    expect(rows[0].claimedNoTouch48h).toBe(1);
    expect(from).not.toHaveBeenCalledWith("email_log");
  });

  it("throws labeled errors when a touch lookup fails", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([member()] as never);
    const dueClaim = {
      ai_flow_runs: {
        data: [
          leadRun(
            { claimed_by: DAVE, claimed_at_ms: Date.parse("2026-07-01T00:00:00Z") },
            "+14805551001",
            "2026-06-30T23:00:00Z",
            null
          )
        ],
        error: null
      },
      voice_call_transcripts: { data: [], error: null }
    };
    await expect(
      getEmployeePerformance("biz-1", {
        client: makeClient({ ...dueClaim, contacts: { data: null, error: { message: "c down" } } })
          .client,
        now: NOW
      })
    ).rejects.toThrow("getEmployeePerformance contacts: c down");
    await expect(
      getEmployeePerformance("biz-1", {
        client: makeClient({
          ...dueClaim,
          sms_outbound_log: { data: null, error: { message: "s down" } }
        }).client,
        now: NOW
      })
    ).rejects.toThrow("getEmployeePerformance sms touches: s down");
    await expect(
      getEmployeePerformance("biz-1", {
        client: makeClient({
          ...dueClaim,
          contacts: {
            data: [{ customer_e164: "+14805551001", alias_e164s: null, email: "l@x.com" }],
            error: null
          },
          email_log: { data: null, error: { message: "e down" } }
        }).client,
        now: NOW
      })
    ).rejects.toThrow("getEmployeePerformance email touches: e down");
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
    expect(rows[0]).toMatchObject({
      offered: 0,
      claimed: 0,
      claimRate: null,
      medianClaimMs: null,
      medianClaimExact: false,
      claimedNoTouch48h: 0
    });

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
