import { describe, expect, it, vi } from "vitest";
import {
  STOP_ON_RESPONSE_CANCELED_BY,
  stopRunsOnResponse
} from "../supabase/functions/_shared/ai_flows/response_stop";

/**
 * Stop-on-response: a lead's inbound text cancels their pending runs of
 * flows whose options.stopOnResponse is true. Mirrors the goal-events
 * guarantees: machine-parked states only, wait-consuming runs exempt, test
 * runs exempt, revision-gated writes, best-effort everywhere.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+16025550111";

type Scripted = { data?: unknown; error?: unknown };

/**
 * Chainable builder: pops one scripted result per terminal await, records
 * every call for wire-shape assertions (mirrors ai-flows-goal-events.test.ts).
 */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq", "or", "in", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

/** A run row as the candidate lookup returns it. */
function runRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    flow_id: "f1",
    status: "queued",
    context: { vars: {}, trigger: { from: LEAD } },
    revision: 5,
    ...over
  };
}

/** An ai_flows row whose definition carries the given options. */
function flowRow(id: string, options: Record<string, unknown> | undefined) {
  return {
    id,
    definition: {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [],
      ...(options ? { options } : {})
    }
  };
}

describe("stopRunsOnResponse", () => {
  it("no lead phone → noop without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await stopRunsOnResponse(db, BIZ, "")).toEqual({ stoppedRuns: 0 });
    expect(calls).toHaveLength(0);
  });

  it("never throws: a client blow-up returns the noop result", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("run lookup error → noop (logged, never thrown)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([{ data: null, error: { message: "down" } }]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("no candidate runs → noop before any flow lookup (null data too)", async () => {
    const { db, calls } = makeDb([{ data: [], error: null }]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(calls.filter((c) => c.table === "ai_flows")).toHaveLength(0);

    const nullData = makeDb([{ data: null, error: null }]);
    expect(await stopRunsOnResponse(nullData.db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
  });

  it("a null flow page cancels nothing (no options to trust)", async () => {
    const { db, calls } = makeDb([
      { data: [runRow()], error: null },
      { data: null, error: null } // flows read returns no rows
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(calls.some((c) => c.name === "update")).toBe(false);
  });

  it("wait-consuming runs (excludeRunIds) and test runs never reach the flow lookup", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          runRow({ id: "r-consumed" }),
          runRow({
            id: "r-test",
            context: { vars: {}, trigger: { from: LEAD, test_mode: true } }
          })
        ],
        error: null
      }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD, ["r-consumed"])).toEqual({
      stoppedRuns: 0
    });
    expect(calls.filter((c) => c.table === "ai_flows")).toHaveLength(0);
  });

  it("a run awaiting THIS sender's reply is exempt even when its resume lost the race", async () => {
    // Not in excludeRunIds (its resume lost the revision race and it is
    // still parked) — the guard must still keep the reply out of a cancel.
    const { db, calls } = makeDb([
      {
        data: [
          runRow({
            id: "r-waiting",
            status: "awaiting_reply",
            context: { vars: {}, trigger: { from: LEAD }, waiting_reply: { from: LEAD } }
          })
        ],
        error: null
      }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(calls.filter((c) => c.table === "ai_flows")).toHaveLength(0);
  });

  it("a wait parked on a DIFFERENT number stays cancelable", async () => {
    const { db } = makeDb([
      {
        data: [
          runRow({
            status: "awaiting_reply",
            context: {
              vars: { lead_phone: LEAD },
              trigger: { from: LEAD },
              waiting_reply: { from: "+16025559999" }
            }
          })
        ],
        error: null
      },
      { data: [flowRow("f1", { stopOnResponse: true })], error: null },
      { data: [{ id: "r1" }], error: null }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 1 });
  });

  it("a flow without stopOnResponse is left alone", async () => {
    const { db, calls } = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", undefined)], error: null }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(calls.some((c) => c.name === "update")).toBe(false);
  });

  it("flow lookup error → noop (candidates in hand but no options to trust)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = makeDb([
      { data: [runRow()], error: null },
      { data: null, error: { message: "flows down" } }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(calls.some((c) => c.name === "update")).toBe(false);
    err.mockRestore();
  });

  it("cancels a stop-on-response run with the owner-stop shape, revision-gated", async () => {
    const { db, calls } = makeDb([
      { data: [runRow({ status: "awaiting_reply" })], error: null },
      { data: [flowRow("f1", { stopOnResponse: true })], error: null },
      { data: [{ id: "r1" }], error: null } // guarded update landed
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 1 });

    const update = calls.find((c) => c.name === "update")!.args[0] as Record<string, unknown>;
    expect(update.status).toBe("canceled");
    expect(update.claimed_at).toBeNull();
    expect(update.respond_by_at).toBeNull();
    const canceled = (update.context as Record<string, unknown>).canceled as Record<
      string,
      unknown
    >;
    expect(canceled.by).toBe(STOP_ON_RESPONSE_CANCELED_BY);
    expect(canceled.from_status).toBe("awaiting_reply");

    // The write is gated on the revision read and the stoppable statuses.
    const updateCallStart = calls.findIndex((c) => c.name === "update");
    const guards = calls.slice(updateCallStart);
    expect(guards.some((c) => c.name === "eq" && c.args[0] === "revision" && c.args[1] === 5)).toBe(
      true
    );
    expect(
      guards.some(
        (c) =>
          c.name === "in" &&
          c.args[0] === "status" &&
          Array.isArray(c.args[1]) &&
          (c.args[1] as string[]).includes("awaiting_call")
      )
    ).toBe(true);
  });

  it("only the stop-on-response flow's runs cancel when a lead has several flows pending", async () => {
    const { db, calls } = makeDb([
      {
        data: [runRow({ id: "r-stop", flow_id: "f-stop" }), runRow({ id: "r-keep", flow_id: "f-keep" })],
        error: null
      },
      {
        data: [flowRow("f-stop", { stopOnResponse: true }), flowRow("f-keep", {})],
        error: null
      },
      { data: [{ id: "r-stop" }], error: null }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 1 });
    const idGuards = calls.filter((c) => c.name === "eq" && c.args[0] === "id");
    expect(idGuards.map((c) => c.args[1])).toEqual(["r-stop"]);
  });

  it("a run with a null context still cancels (audit entry built from scratch)", async () => {
    const { db, calls } = makeDb([
      { data: [runRow({ context: null })], error: null },
      { data: [flowRow("f1", { stopOnResponse: true })], error: null },
      { data: [{ id: "r1" }], error: null }
    ]);
    expect(await stopRunsOnResponse(db, BIZ, LEAD)).toEqual({ stoppedRuns: 1 });
    const update = calls.find((c) => c.name === "update")!.args[0] as Record<string, unknown>;
    expect((update.context as Record<string, unknown>).canceled).toBeDefined();
  });

  it("a lost revision race or a write error counts nothing (and never throws)", async () => {
    const raced = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", { stopOnResponse: true })], error: null },
      { data: [], error: null } // guarded update matched zero rows
    ]);
    expect(await stopRunsOnResponse(raced.db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });

    // A null updated payload (no rows selected back) is the same lost race.
    const nullUpdated = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", { stopOnResponse: true })], error: null },
      { data: null, error: null }
    ]);
    expect(await stopRunsOnResponse(nullUpdated.db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", { stopOnResponse: true })], error: null },
      { data: null, error: { message: "write down" } }
    ]);
    expect(await stopRunsOnResponse(failed.db, BIZ, LEAD)).toEqual({ stoppedRuns: 0 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
