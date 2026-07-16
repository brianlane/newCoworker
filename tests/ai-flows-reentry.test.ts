import { describe, expect, it, vi } from "vitest";
import {
  flowBlocksReentry,
  hasPriorRunForLead,
  reentryBlocked
} from "../supabase/functions/_shared/ai_flows/reentry";

/**
 * Re-entry gate: a flow with options.allowReentry === false never re-enrolls
 * a contact who already has a (non-test) run of it. Best-effort — a lookup
 * failure fails OPEN (the run enqueues) because a dropped lead is worse than
 * a duplicate follow-up.
 */

const LEAD = "+16025550111";

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "limit"]) {
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

const defWith = (options?: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "sms", conditions: [] },
  steps: [],
  ...(options ? { options } : {})
});

describe("flowBlocksReentry", () => {
  it("only an explicit false blocks; default/true/malformed allow", () => {
    expect(flowBlocksReentry(defWith({ allowReentry: false }))).toBe(true);
    expect(flowBlocksReentry(defWith({ allowReentry: true }))).toBe(false);
    expect(flowBlocksReentry(defWith({}))).toBe(false);
    expect(flowBlocksReentry(defWith())).toBe(false);
    expect(flowBlocksReentry(null)).toBe(false);
    expect(flowBlocksReentry("junk")).toBe(false);
  });
});

describe("hasPriorRunForLead", () => {
  it("no lead → false without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await hasPriorRunForLead(db, "f1", "")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a prior non-test run blocks; the query keys on flow + lead identity", async () => {
    const { db, calls } = makeDb([
      { data: [{ context: { trigger: { from: LEAD } } }], error: null }
    ]);
    expect(await hasPriorRunForLead(db, "f1", LEAD)).toBe(true);
    expect(calls.some((c) => c.name === "eq" && c.args[0] === "flow_id" && c.args[1] === "f1")).toBe(
      true
    );
    const or = calls.find((c) => c.name === "or")!.args[0] as string;
    expect(or).toContain(`context->trigger->>from.eq.${LEAD}`);
    expect(or).toContain(`context->vars->>lead_phone.eq.${LEAD}`);
    // Full identity parity with goal_events/response_stop: waits and calls too.
    expect(or).toContain(`context->waiting_reply->>from.eq.${LEAD}`);
    expect(or).toContain(`context->waiting_call->>to.eq.${LEAD}`);
  });

  it("test runs never count as an enrollment", async () => {
    const { db } = makeDb([
      { data: [{ context: { trigger: { from: LEAD, test_mode: true } } }], error: null }
    ]);
    expect(await hasPriorRunForLead(db, "f1", LEAD)).toBe(false);
  });

  it("no prior rows → false (null data too)", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    expect(await hasPriorRunForLead(db, "f1", LEAD)).toBe(false);

    const nullData = makeDb([{ data: null, error: null }]);
    expect(await hasPriorRunForLead(nullData.db, "f1", LEAD)).toBe(false);
  });

  it("fails OPEN on a lookup error or a client blow-up", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([{ data: null, error: { message: "down" } }]);
    expect(await hasPriorRunForLead(db, "f1", LEAD)).toBe(false);

    const thrown = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await hasPriorRunForLead(thrown, "f1", LEAD)).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("reentryBlocked", () => {
  it("a flow that allows re-entry (the default) never queries the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await reentryBlocked(db, "f1", defWith(), LEAD)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("no lead identity → never blocked (webhook-style enqueues pass through)", async () => {
    const { db, calls } = makeDb([]);
    expect(await reentryBlocked(db, "f1", defWith({ allowReentry: false }), "")).toBe(false);
    expect(await reentryBlocked(db, "f1", defWith({ allowReentry: false }), null)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("blocks when the flow opts out and the lead already ran it", async () => {
    const { db } = makeDb([{ data: [{ context: { trigger: { from: LEAD } } }], error: null }]);
    expect(await reentryBlocked(db, "f1", defWith({ allowReentry: false }), LEAD)).toBe(true);
  });

  it("does not block a first enrollment", async () => {
    const { db } = makeDb([{ data: [], error: null }]);
    expect(await reentryBlocked(db, "f1", defWith({ allowReentry: false }), LEAD)).toBe(false);
  });
});
