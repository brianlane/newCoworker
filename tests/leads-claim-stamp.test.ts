import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  CLAIM_STAMP_RUN_SCAN_LIMIT,
  stampLeadClaimOnRun,
  stampRoutingClaim
} from "@/lib/leads/claim-stamp";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const LEAD = "+14805551001";
const DAVE = "+16025550001";
const AT = Date.parse("2026-07-01T10:20:00Z");

type QueryResult = { data?: unknown; error: { message: string } | null };

/**
 * Sequential query mock: each `from()` consumes the next queued result, so
 * the read (candidates) and the write (CAS update) on the same table can
 * resolve differently. Every chained op is recorded per query for
 * assertions.
 */
function makeDb(results: QueryResult[]) {
  let next = 0;
  const queries: Array<{ table: string; ops: Array<{ name: string; args: unknown[] }> }> = [];
  const from = vi.fn((table: string) => {
    const ops: Array<{ name: string; args: unknown[] }> = [];
    queries.push({ table, ops });
    const result = results[next] ?? { data: [], error: null };
    next += 1;
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "or", "order", "limit", "update"]) {
      chain[m] = vi.fn((...args: unknown[]) => {
        ops.push({ name: m, args });
        return chain;
      });
    }
    (chain as { then: unknown }).then = (
      resolve: (v: QueryResult) => unknown,
      reject: (e: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { db: { from } as never, queries, from };
}

function candidate(context: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return { id: "run-1", context, revision: 4, ...over };
}

const routedContext = (routing: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  vars: { lead_phone: LEAD },
  routing,
  ...extra
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stampRoutingClaim", () => {
  it("records who, when, and (when known) the roster name on a copy", () => {
    const routing = { offered_log: [DAVE] };
    const stamped = stampRoutingClaim(routing, {
      claimedByE164: DAVE,
      claimedByName: " Dave ",
      atMs: AT
    });
    expect(stamped).toEqual({
      offered_log: [DAVE],
      claimed_by: DAVE,
      claimed_name: "Dave",
      claimed_at_ms: AT
    });
    // Shallow copy: the source routing was not mutated.
    expect(routing).toEqual({ offered_log: [DAVE] });
  });

  it("leaves claimed_name alone when no usable name was given", () => {
    expect(stampRoutingClaim({}, { claimedByE164: DAVE, atMs: AT })).toEqual({
      claimed_by: DAVE,
      claimed_at_ms: AT
    });
    expect(
      stampRoutingClaim({ claimed_name: "Old" }, { claimedByE164: DAVE, claimedByName: "  ", atMs: AT })
    ).toEqual({ claimed_by: DAVE, claimed_name: "Old", claimed_at_ms: AT });
  });
});

describe("stampLeadClaimOnRun", () => {
  it("refuses junk identifiers before touching the database", async () => {
    expect(
      await stampLeadClaimOnRun(undefined, {
        businessId: "biz-1",
        leadE164: "not-a-phone",
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: false, runId: null });
    expect(
      await stampLeadClaimOnRun(undefined, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: "garbage"
      })
    ).toEqual({ stamped: false, runId: null });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("stamps the newest run that truly belongs to the lead (CAS on revision)", async () => {
    const { db, queries } = makeDb([
      {
        data: [
          // A run whose context vanished: skipped.
          candidate(null, { id: "run-null" }),
          // trigger.from matched the or() but the EXTRACTED lead is someone
          // else: ownership never binds to the sender, skipped.
          candidate(
            { vars: { lead_phone: "+19998887777" }, trigger: { from: LEAD }, routing: {} },
            { id: "run-other-lead" }
          ),
          // Routing malformed (array): skipped.
          candidate({ vars: { lead_phone: LEAD }, routing: ["bad"] }, { id: "run-bad-routing" }),
          candidate(routedContext({ offered_log: [DAVE] }, { trigger: { channel: "sms" } }))
        ],
        error: null
      },
      { data: [{ id: "run-1" }], error: null }
    ]);
    const result = await stampLeadClaimOnRun(db, {
      businessId: "biz-1",
      leadE164: ` ${LEAD} `,
      claimedByE164: DAVE,
      claimedByName: "Dave",
      nowMs: AT
    });
    expect(result).toEqual({ stamped: true, runId: "run-1" });

    const [read, write] = queries;
    expect(read.table).toBe("ai_flow_runs");
    expect(read.ops).toContainEqual({ name: "not", args: ["context->routing", "is", null] });
    expect(read.ops).toContainEqual({
      name: "or",
      args: [`context->vars->>lead_phone.eq.${LEAD},context->trigger->>from.eq.${LEAD}`]
    });
    expect(read.ops).toContainEqual({ name: "limit", args: [CLAIM_STAMP_RUN_SCAN_LIMIT] });

    expect(write.table).toBe("ai_flow_runs");
    const update = write.ops.find((o) => o.name === "update")!;
    const payload = update.args[0] as { context: Record<string, unknown>; updated_at: string };
    // The rest of the context (vars, trigger) survives the stamp.
    expect(payload.context).toEqual({
      vars: { lead_phone: LEAD },
      trigger: { channel: "sms" },
      routing: {
        offered_log: [DAVE],
        claimed_by: DAVE,
        claimed_name: "Dave",
        claimed_at_ms: AT
      }
    });
    expect(typeof payload.updated_at).toBe("string");
    // First writer wins: the update is gated on the revision the read saw.
    expect(write.ops).toContainEqual({ name: "eq", args: ["revision", 4] });
    expect(write.ops).toContainEqual({ name: "eq", args: ["id", "run-1"] });
  });

  it("defaults the clock and the client when the caller passes neither", async () => {
    const { db } = makeDb([
      { data: [candidate(routedContext({}))], error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.spyOn(Date, "now").mockReturnValue(AT + 5);
    const result = await stampLeadClaimOnRun(undefined, {
      businessId: "biz-1",
      leadE164: LEAD,
      claimedByE164: DAVE
    });
    expect(result).toEqual({ stamped: true, runId: "run-1" });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("reports an un-routed lead as nothing to stamp", async () => {
    const empty = makeDb([{ data: [], error: null }]);
    expect(
      await stampLeadClaimOnRun(empty.db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: false, runId: null });

    const nullPage = makeDb([{ data: null, error: null }]);
    expect(
      await stampLeadClaimOnRun(nullPage.db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: false, runId: null });
  });

  it("never steals a run somebody else already claimed", async () => {
    const { db, queries } = makeDb([
      { data: [candidate(routedContext({ claimed_by: "+19998887777" }))], error: null }
    ]);
    expect(
      await stampLeadClaimOnRun(db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: false, runId: "run-1" });
    // No write was attempted.
    expect(queries).toHaveLength(1);
  });

  it("is idempotent for a claim this teammate already stamped", async () => {
    const { db, queries } = makeDb([
      { data: [candidate(routedContext({ claimed_by: DAVE, claimed_at_ms: AT }))], error: null }
    ]);
    expect(
      await stampLeadClaimOnRun(db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: true, runId: "run-1" });
    expect(queries).toHaveLength(1);
  });

  it("backfills the clock on a legacy self-claim that predates stamping", async () => {
    const { db, queries } = makeDb([
      { data: [candidate(routedContext({ claimed_by: DAVE, claimed_name: "Dave" }))], error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    expect(
      await stampLeadClaimOnRun(db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE,
        nowMs: AT
      })
    ).toEqual({ stamped: true, runId: "run-1" });
    const update = queries[1].ops.find((o) => o.name === "update")!;
    const payload = update.args[0] as { context: { routing: Record<string, unknown> } };
    expect(payload.context.routing).toEqual({
      claimed_by: DAVE,
      claimed_name: "Dave",
      claimed_at_ms: AT
    });
  });

  it("degrades to un-stamped on read errors, write errors, lost races, and throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const readError = makeDb([{ data: null, error: { message: "read down" } }]);
    expect(
      await stampLeadClaimOnRun(readError.db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: false, runId: null });

    const writeError = makeDb([
      { data: [candidate(routedContext({}))], error: null },
      { data: null, error: { message: "write down" } }
    ]);
    expect(
      await stampLeadClaimOnRun(writeError.db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE,
        nowMs: AT
      })
    ).toEqual({ stamped: false, runId: "run-1" });

    // Zero rows back from the CAS: the webhook or worker wrote first; their
    // claim stands and this one reports the loss instead of retrying.
    const lostRace = makeDb([
      { data: [candidate(routedContext({}))], error: null },
      { data: null, error: null }
    ]);
    expect(
      await stampLeadClaimOnRun(lostRace.db, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE,
        nowMs: AT
      })
    ).toEqual({ stamped: false, runId: "run-1" });

    const thrown = {
      from: vi.fn(() => {
        throw new Error("boom");
      })
    } as never;
    expect(
      await stampLeadClaimOnRun(thrown, {
        businessId: "biz-1",
        leadE164: LEAD,
        claimedByE164: DAVE
      })
    ).toEqual({ stamped: false, runId: null });
    expect(consoleError).toHaveBeenCalled();
  });
});
