import { describe, expect, it, vi } from "vitest";
import {
  flowOwnsCoworkerTurn,
  resumeAwaitingReplyRun
} from "../supabase/functions/_shared/ai_flows/wait_reply_resume";

/**
 * wait_for_reply resume: capture the inbound into the parked run, and only
 * mute the coworker when the waiting flow set suppressDefaultReply.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const FROM = "+14035550111";
const FLOW_ID = "00000000-0000-0000-0000-0000000000aa";
const RUN_ID = "00000000-0000-0000-0000-0000000000bb";

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq", "in", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  const rpc = async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ table: "", name: "rpc", args: [fn, args] });
    return next();
  };
  return { db: { from, rpc }, calls };
}

function parkedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    flow_id: FLOW_ID,
    revision: 3,
    context: {
      vars: { lead_phone: FROM },
      waiting_reply: { from: FROM }
    },
    ...overrides
  };
}

describe("flowOwnsCoworkerTurn", () => {
  it("is true only for the explicit flag", () => {
    expect(flowOwnsCoworkerTurn(null)).toBe(false);
    expect(flowOwnsCoworkerTurn("nope")).toBe(false);
    expect(flowOwnsCoworkerTurn({})).toBe(false);
    expect(flowOwnsCoworkerTurn({ options: {} })).toBe(false);
    expect(flowOwnsCoworkerTurn({ options: { suppressDefaultReply: false } })).toBe(false);
    expect(flowOwnsCoworkerTurn({ options: { suppressDefaultReply: true } })).toBe(true);
  });
});

describe("resumeAwaitingReplyRun", () => {
  it("no sender → empty without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await resumeAwaitingReplyRun(db, BIZ, null, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
    expect(await resumeAwaitingReplyRun(db, BIZ, "", "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
    expect(calls).toHaveLength(0);
  });

  it("never throws: a client blow-up returns empty", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
    err.mockRestore();
  });

  it("no parked runs → empty", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
  });

  it("a null parked-run payload is treated as none", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
  });

  it("a cadence wait without suppressDefaultReply does not mute the coworker", async () => {
    const { db, calls } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: [{ id: FLOW_ID, definition: { options: {} } }], error: null }
    ]);
    const res = await resumeAwaitingReplyRun(db, BIZ, FROM, "I booked, unsure of the time");
    expect(res).toEqual({ resumedIds: [RUN_ID], suppressCoworker: false });
    expect(calls.some((c) => c.name === "rpc" && c.args[0] === "telemetry_record")).toBe(true);
    const update = calls.find((c) => c.table === "ai_flow_runs" && c.name === "update");
    const ctx = (update?.args[0] as { context: Record<string, unknown> }).context;
    expect((ctx.vars as Record<string, unknown>).reply_text).toBe("I booked, unsure of the time");
    expect((ctx.waiting_reply as { result: string }).result).toBe("reply");
  });

  it("writes a custom saveAs and stamps the wait marker", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          parkedRun({
            context: {
              vars: { lead_phone: FROM },
              waiting_reply: { from: FROM, save_as: "reply_final", marker: "__waited_s_wait_final" }
            }
          })
        ],
        error: null
      },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      {
        data: [{ id: FLOW_ID, definition: { options: { suppressDefaultReply: false } } }],
        error: null
      }
    ]);
    await resumeAwaitingReplyRun(db, BIZ, FROM, "booked");
    const update = calls.find((c) => c.table === "ai_flow_runs" && c.name === "update");
    const vars = (update?.args[0] as { context: { vars: Record<string, unknown> } }).context.vars;
    expect(vars.reply_final).toBe("booked");
    expect(vars.__waited_s_wait_final).toBe("1");
  });

  it("odd context shapes still resume with the default saveAs", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          parkedRun({
            context: {
              vars: "not-an-object",
              waiting_reply: { from: FROM, save_as: "   ", marker: "   " }
            }
          })
        ],
        error: null
      },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: [{ id: FLOW_ID, definition: {} }], error: null }
    ]);
    await resumeAwaitingReplyRun(db, BIZ, FROM, "hi");
    const update = calls.find((c) => c.table === "ai_flow_runs" && c.name === "update");
    const ctx = (update?.args[0] as { context: Record<string, unknown> }).context;
    expect((ctx.vars as Record<string, unknown>).reply_text).toBe("hi");
  });

  it("a null context object still resumes", async () => {
    const { db, calls } = makeDb([
      { data: [parkedRun({ context: null })], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: [{ id: FLOW_ID, definition: {} }], error: null }
    ]);
    await resumeAwaitingReplyRun(db, BIZ, FROM, "hi");
    const update = calls.find((c) => c.table === "ai_flow_runs" && c.name === "update");
    const vars = (update?.args[0] as { context: { vars: Record<string, unknown> } }).context.vars;
    expect(vars.reply_text).toBe("hi");
  });

  it("clamps the captured text to 4000 characters", async () => {
    const { db, calls } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: [{ id: FLOW_ID, definition: {} }], error: null }
    ]);
    const long = "x".repeat(4500);
    await resumeAwaitingReplyRun(db, BIZ, FROM, long);
    const update = calls.find((c) => c.table === "ai_flow_runs" && c.name === "update");
    const vars = (update?.args[0] as { context: { vars: Record<string, unknown> } }).context.vars;
    expect((vars.reply_text as string).length).toBe(4000);
  });

  it("a suppressDefaultReply flow still mutes the coworker", async () => {
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      {
        data: [{ id: FLOW_ID, definition: { options: { suppressDefaultReply: true } } }],
        error: null
      }
    ]);
    const res = await resumeAwaitingReplyRun(db, BIZ, FROM, "yes call me");
    expect(res).toEqual({ resumedIds: [RUN_ID], suppressCoworker: true });
  });

  it("mutes when any resumed flow owns the turn", async () => {
    const run2 = "00000000-0000-0000-0000-0000000000cc";
    const flow2 = "00000000-0000-0000-0000-0000000000dd";
    const { db } = makeDb([
      {
        data: [parkedRun(), parkedRun({ id: run2, flow_id: flow2 })],
        error: null
      },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: [{ id: run2 }], error: null },
      { error: null },
      {
        data: [
          { id: FLOW_ID, definition: { options: {} } },
          { id: flow2, definition: { options: { suppressDefaultReply: true } } }
        ],
        error: null
      }
    ]);
    const res = await resumeAwaitingReplyRun(db, BIZ, FROM, "hi");
    expect(res.resumedIds).toEqual([RUN_ID, run2]);
    expect(res.suppressCoworker).toBe(true);
  });

  it("a resume error skips that run and continues", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: null, error: { message: "revision raced" } }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
    err.mockRestore();
  });

  it("a lost revision race (zero updated rows) does not count as resumed", async () => {
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [], error: null }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
  });

  it("a null update payload is treated as a lost race", async () => {
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: null, error: null }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [],
      suppressCoworker: false
    });
  });

  it("a resumed row with no flow_id fails closed (mute)", async () => {
    const { db } = makeDb([
      { data: [parkedRun({ flow_id: null })], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [RUN_ID],
      suppressCoworker: true
    });
  });

  it("an empty-string flow_id fails closed (mute)", async () => {
    const { db } = makeDb([
      { data: [parkedRun({ flow_id: "" })], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [RUN_ID],
      suppressCoworker: true
    });
  });

  it("a flow-options read failure fails closed (mute)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: null, error: { message: "timeout" } }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [RUN_ID],
      suppressCoworker: true
    });
    err.mockRestore();
  });

  it("a missing flow row does not mute (cadence waits are the common shape)", async () => {
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: [], error: null }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [RUN_ID],
      suppressCoworker: false
    });
  });

  it("a null flow-lookup payload is treated as no rows", async () => {
    const { db } = makeDb([
      { data: [parkedRun()], error: null },
      { data: [{ id: RUN_ID }], error: null },
      { error: null },
      { data: null, error: null }
    ]);
    expect(await resumeAwaitingReplyRun(db, BIZ, FROM, "hi")).toEqual({
      resumedIds: [RUN_ID],
      suppressCoworker: false
    });
  });
});
