import { describe, expect, it, vi } from "vitest";
import {
  FLOW_CONTEXT_LOOKBACK_HOURS,
  formatBusinessFlowActivity,
  formatFlowAnswerNote,
  formatFlowRunContext,
  loadBusinessFlowActivity,
  loadFlowRunContext,
  loadFlowRunContextDetailed,
  presentableVars,
  type FlowRunSnapshot
} from "../supabase/functions/_shared/ai_flows/run_context";

/**
 * AiFlow → AI-worker context bridge: after an automation texts a lead, the
 * generic reply path must know what the flow collected and last said, so it
 * continues the thread instead of restarting intake (the Truly Insurance
 * 2026-07-11 incident: the model asked a lead for their phone number over
 * SMS one turn after the flow had extracted it).
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+14168775223";

const snapshot = (over: Partial<FlowRunSnapshot> = {}): FlowRunSnapshot => ({
  flowName: "Lead intake & follow-up",
  status: "done",
  updatedAt: "2026-07-11T12:39:05Z",
  vars: { lead_name: "Dwight Colclough", product: "auto_insurance" },
  ...over
});

describe("presentableVars", () => {
  it("drops engine markers, empties, and nullish values; stringifies the rest", () => {
    const vars = presentableVars({
      lead_name: "Dwight",
      __branch_fork: "arm_replied",
      empty: "   ",
      missing: null,
      gone: undefined,
      count: 7,
      flags: { a: 1 }
    });
    expect(vars).toEqual([
      ["lead_name", "Dwight"],
      ["count", "7"],
      ["flags", '{"a":1}']
    ]);
  });

  it("clips long values and caps the list at 12 entries", () => {
    const vars: Record<string, unknown> = { long: "x".repeat(500) };
    for (let i = 0; i < 20; i += 1) vars[`k${i}`] = `v${i}`;
    const out = presentableVars(vars);
    expect(out).toHaveLength(12);
    expect(out[0][1]).toHaveLength(160);
    expect(out[0][1].endsWith("…")).toBe(true);
  });
});

describe("formatFlowRunContext", () => {
  it("null when there are no runs and no recent messages (nothing to say)", () => {
    expect(formatFlowRunContext([], [])).toBeNull();
    expect(formatFlowRunContext([], ["   "])).toBeNull();
  });

  it("lists each run's workflow, status phrase, and collected vars", () => {
    const text = formatFlowRunContext([snapshot()], []);
    expect(text).toContain('Workflow "Lead intake & follow-up" — finished, last update 2026-07-11T12:39:05Z:');
    expect(text).toContain("- lead_name: Dwight Colclough");
    expect(text).toContain("- product: auto_insurance");
    expect(text).toContain("treat them as KNOWN");
    // No recent messages → no already-sent block.
    expect(text).not.toContain("Messages the automation ALREADY texted");
  });

  it("phrases every run status for the model (raw status as fallback)", () => {
    for (const [status, phrase] of [
      ["queued", "in progress"],
      ["running", "in progress"],
      ["awaiting_reply", "waiting for this contact's reply"],
      ["awaiting_call", "on an AI phone call with this contact"],
      ["awaiting_approval", "waiting on an owner approval"],
      ["awaiting_agent", "waiting on a teammate to claim"],
      ["done", "finished"],
      ["failed", "stopped with an error"],
      ["paused_by_call", "paused_by_call"]
    ] as const) {
      expect(formatFlowRunContext([snapshot({ status })], [])).toContain(`— ${phrase}`);
    }
  });

  it("handles a run with no timestamps and no presentable vars", () => {
    const text = formatFlowRunContext(
      [snapshot({ updatedAt: null, vars: { __goal_g1: "replied" } })],
      []
    );
    expect(text).toContain('Workflow "Lead intake & follow-up" — finished:');
    expect(text).toContain("- (no collected details)");
  });

  it("caps at three runs (newest first is the caller's ordering)", () => {
    const runs = [1, 2, 3, 4].map((i) => snapshot({ flowName: `Flow ${i}` }));
    const text = formatFlowRunContext(runs, []);
    expect(text).toContain('Workflow "Flow 3"');
    expect(text).not.toContain('Workflow "Flow 4"');
  });

  it("numbers every already-sent message (oldest first) with the never-repeat instruction", () => {
    // The 2026-07-13 incident: only the NEWEST flow message was quoted, so
    // the model re-sent the flow's earlier question verbatim. Every recent
    // automated message must be marked as already-delivered.
    const text = formatFlowRunContext(
      [snapshot()],
      [
        "Hi Dwight! What prompted you to shop around today?",
        "Approximately when does your current policy renew?"
      ]
    );
    expect(text).toContain("Messages the automation ALREADY texted this contact (oldest first):");
    expect(text).toContain('1. "Hi Dwight! What prompted you to shop around today?"');
    expect(text).toContain('2. "Approximately when does your current policy renew?"');
    expect(text).toContain("NEVER send them again");
    expect(text).toContain("never re-ask a question they contain");
    expect(text).toContain("continue THAT thread naturally");
  });

  it("caps the already-sent list at three and drops blank entries", () => {
    const text = formatFlowRunContext([], ["m1", "  ", "m2", "m3", "m4"]);
    expect(text).not.toContain('"m1"');
    expect(text).toContain('1. "m2"');
    expect(text).toContain('2. "m3"');
    expect(text).toContain('3. "m4"');
  });

  it("a recent automated message alone (no runs in-window) is still context", () => {
    const text = formatFlowRunContext([], ["Hi Dwight! What prompted you to shop around today?"]);
    expect(text).toContain("Automation context");
    expect(text).toContain("What prompted you to shop around today?");
  });

  it("clips a very long message", () => {
    const text = formatFlowRunContext([], [`start ${"y".repeat(600)}`]);
    expect(text).toContain("start ");
    expect(text).toContain("…");
    expect(text).not.toContain("y".repeat(400));
  });
});

describe("formatBusinessFlowActivity", () => {
  it("null when there is no recent activity", () => {
    expect(formatBusinessFlowActivity([])).toBeNull();
  });

  it("one line per run with lead label and status; caps at ten", () => {
    const runs = Array.from({ length: 11 }, (_, i) => ({
      ...snapshot({ flowName: `Flow ${i + 1}`, status: "awaiting_reply" }),
      leadLabel: i === 0 ? "Dwight Colclough (+14168775223)" : null
    }));
    runs[1] = { ...runs[1], updatedAt: null };
    const text = formatBusinessFlowActivity(runs);
    expect(text).toContain(
      '- "Flow 1" for Dwight Colclough (+14168775223): waiting for this contact\'s reply (last update 2026-07-11T12:39:05Z)'
    );
    expect(text).toContain('- "Flow 2": waiting for this contact\'s reply');
    expect(text).toContain('- "Flow 10"');
    expect(text).not.toContain('- "Flow 11"');
  });
});

// ---------------------------------------------------------------------------
// Loaders (fake chainable client, one scripted result per terminal await)
// ---------------------------------------------------------------------------

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "or", "in", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from: (t: string) => (calls.push({ table: t, name: "from", args: [] }), from(t)) }, calls };
}

function dbRun(over: Partial<Record<string, unknown>> = {}) {
  return {
    flow_id: "f1",
    status: "done",
    updated_at: "2026-07-11T12:39:05Z",
    context: {
      trigger: { channel: "tenant_email", from: LEAD },
      vars: { lead_name: "Dwight Colclough", lead_phone: LEAD, __branch_x: "y" }
    },
    ...over
  };
}

describe("loadFlowRunContext", () => {
  it("no contact number → null without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await loadFlowRunContext(db, BIZ, "")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("assembles runs + flow names + the last automated message", async () => {
    const { db, calls } = makeDb([
      { data: [dbRun()] },
      { data: [{ id: "f1", name: "Lead intake & follow-up (Privyr)" }] },
      { data: [{ body: "Approximately when does your current policy renew?" }] }
    ]);
    const text = await loadFlowRunContext(db, BIZ, LEAD);
    expect(text).toContain('Workflow "Lead intake & follow-up (Privyr)" — finished');
    expect(text).toContain("- lead_name: Dwight Colclough");
    expect(text).not.toContain("__branch_x");
    expect(text).toContain("when does your current policy renew?");

    // Wire shape: lead-identity OR (same keys as goal_events), query-level
    // test-run exclusion (test runs must not starve live runs out of the
    // page limit), lookback filter, and the ai_flow-only outbound lookup.
    const ors = calls.filter((c) => c.name === "or");
    expect(ors[0]?.args[0]).toContain(`context->trigger->>from.eq.${LEAD}`);
    expect(ors[0]?.args[0]).toContain(`context->vars->>lead_phone.eq.${LEAD}`);
    expect(ors[0]?.args[0]).toContain(`context->waiting_reply->>from.eq.${LEAD}`);
    expect(ors[1]?.args[0]).toContain("test_mode.is.null");
    expect(ors[1]?.args[0]).toContain("test_mode.neq.true");
    expect(calls.filter((c) => c.name === "gte")).toHaveLength(2);
    const outboundSource = calls.find(
      (c) => c.table === "sms_outbound_log" && c.name === "eq" && c.args[0] === "source"
    );
    expect(outboundSource?.args[1]).toBe("ai_flow");
  });

  it("test runs are dropped in memory even if the query predicate missed them", async () => {
    const { db } = makeDb([
      {
        data: [
          dbRun({ context: { trigger: { test_mode: true }, vars: { lead_name: "X" } } }),
          dbRun()
        ]
      },
      { data: [{ id: "f1", name: "Privyr intake" }] },
      { data: [] }
    ]);
    const text = await loadFlowRunContext(db, BIZ, LEAD);
    expect(text).toContain("Dwight Colclough");
    expect(text?.match(/Workflow "/g)).toHaveLength(1);
  });

  it("no runs in the window: skips the flow-name lookup, still surfaces a recent flow message", async () => {
    const { db, calls } = makeDb([
      { data: null },
      { data: [{ body: "Hi Dwight! What prompted you to shop around today?" }] }
    ]);
    const text = await loadFlowRunContext(db, BIZ, LEAD);
    expect(text).toContain("What prompted you to shop around today?");
    expect(calls.filter((c) => c.table === "ai_flows")).toHaveLength(0);
  });

  it("degrades to null on a run-query error; reply path must proceed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await loadFlowRunContext(db, BIZ, LEAD)).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a flow-name lookup error labels runs 'Untitled workflow' instead of failing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([
      { data: [dbRun()] },
      { data: null, error: { message: "boom" } },
      { data: [] }
    ]);
    const text = await loadFlowRunContext(db, BIZ, LEAD);
    expect(text).toContain('Workflow "Untitled workflow"');
    err.mockRestore();
  });

  it("an empty flow-name result set (no error) also falls back to 'Untitled workflow'", async () => {
    const { db } = makeDb([{ data: [dbRun()] }, { data: null }, { data: [] }]);
    const text = await loadFlowRunContext(db, BIZ, LEAD);
    expect(text).toContain('Workflow "Untitled workflow"');
  });

  it("a blank stored flow name also falls back to 'Untitled workflow'", async () => {
    const { db } = makeDb([
      { data: [dbRun()] },
      { data: [{ id: "f1", name: "  " }, { id: "f2" }] },
      { data: [] }
    ]);
    const text = await loadFlowRunContext(db, BIZ, LEAD);
    expect(text).toContain('Workflow "Untitled workflow"');
  });

  it("outbound-log errors and unusable bodies leave the last-message block off", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const outbound of [
      { data: null, error: { message: "boom" } },
      { data: null },
      { data: [{ body: "   " }] },
      { data: [{ body: null }] }
    ]) {
      const { db } = makeDb([
        { data: [dbRun()] },
        { data: [{ id: "f1", name: "Privyr intake" }] },
        outbound
      ]);
      const text = await loadFlowRunContext(db, BIZ, LEAD);
      expect(text).toContain('Workflow "Privyr intake"');
      expect(text).not.toContain("Messages the automation ALREADY texted");
    }
    err.mockRestore();
  });

  it("never throws: a client blow-up returns null", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await loadFlowRunContext(db, BIZ, LEAD)).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("exports the lookback window the loaders and callers share", () => {
    expect(FLOW_CONTEXT_LOOKBACK_HOURS).toBe(72);
  });
});

describe("loadFlowRunContextDetailed", () => {
  it("returns the block AND the raw recent messages (oldest first, trimmed)", async () => {
    const { db } = makeDb([
      { data: [dbRun()] },
      { data: [{ id: "f1", name: "Privyr intake" }] },
      {
        data: [
          { body: "  Approximately when does your current policy renew?  " },
          { body: "Hi Dwight! What prompted you to shop around today?" }
        ]
      }
    ]);
    const detail = await loadFlowRunContextDetailed(db, BIZ, LEAD);
    expect(detail.block).toContain('Workflow "Privyr intake"');
    // Query is newest-first; recentMessages reads oldest-first like the block.
    expect(detail.recentMessages).toEqual([
      "Hi Dwight! What prompted you to shop around today?",
      "Approximately when does your current policy renew?"
    ]);
  });

  it("empty contact and query errors return the empty detail, never throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db: emptyDb, calls } = makeDb([]);
    expect(await loadFlowRunContextDetailed(emptyDb, BIZ, "")).toEqual({
      block: null,
      recentMessages: []
    });
    expect(calls).toHaveLength(0);
    const { db: errDb } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await loadFlowRunContextDetailed(errDb, BIZ, LEAD)).toEqual({
      block: null,
      recentMessages: []
    });
    err.mockRestore();
  });
});

describe("formatFlowAnswerNote", () => {
  it("anchors the last automated message next to the user turn with the act-on-it clause", () => {
    const note = formatFlowAnswerNote("Approximately when does your current policy renew?");
    expect(note).toContain(
      '(Note: the last automated message to this texter was: ' +
        '"Approximately when does your current policy renew?" — read their ' +
        "message below as a likely answer to it, and ACT on that answer in this reply."
    );
    // The Bryan clause (Amy 2026-07-14): an "available now" answer must be
    // acted on, never bounced into a schedule-for-later negotiation.
    expect(note).toContain("saying they are available now, help them right now");
    expect(note).toContain("do NOT ask them to schedule for later");
    expect(note!.endsWith(")")).toBe(true);
  });

  it("clips a runaway message and returns null for blank input", () => {
    const note = formatFlowAnswerNote(`${"x".repeat(400)}`);
    expect(note).toContain("…");
    // The quoted flow message itself stays capped at MAX_LAST_MESSAGE_CHARS
    // regardless of the surrounding instruction text.
    const quoted = note!.slice(note!.indexOf('"') + 1, note!.lastIndexOf('"'));
    expect(quoted.length).toBeLessThanOrEqual(300);
    expect(formatFlowAnswerNote("   ")).toBeNull();
    expect(formatFlowAnswerNote("")).toBeNull();
  });
});

describe("loadBusinessFlowActivity", () => {
  it("digest lines carry the best available lead identity (test runs excluded at the query)", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          dbRun(),
          dbRun({
            flow_id: "f2",
            status: "awaiting_reply",
            context: { vars: { lead_name: "Ana" } }
          }),
          dbRun({ flow_id: "f2", context: { vars: { lead_phone: "" }, trigger: { from: "+16025550111" } } }),
          dbRun({ flow_id: "f2", context: null, updated_at: null })
        ]
      },
      {
        data: [
          { id: "f1", name: "Privyr intake" },
          { id: "f2", name: "Post-appointment follow-up" }
        ]
      }
    ]);
    const text = await loadBusinessFlowActivity(db, BIZ);
    expect(text).toContain(`- "Privyr intake" for Dwight Colclough (${LEAD}): finished`);
    expect(text).toContain('- "Post-appointment follow-up" for Ana: waiting for this contact\'s reply');
    expect(text).toContain('for +16025550111: finished');
    expect(text).toContain('- "Post-appointment follow-up": finished');
    const or = calls.find((c) => c.name === "or");
    expect(or?.args[0]).toContain("test_mode.is.null");
  });

  it("no recent runs (empty page or null data) → null", async () => {
    const { db } = makeDb([{ data: [] }]);
    expect(await loadBusinessFlowActivity(db, BIZ)).toBeNull();
    const { db: nullDb } = makeDb([{ data: null }]);
    expect(await loadBusinessFlowActivity(nullDb, BIZ)).toBeNull();
  });

  it("degrades to null on query error or client blow-up", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await loadBusinessFlowActivity(db, BIZ)).toBeNull();
    const throwing = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await loadBusinessFlowActivity(throwing, BIZ)).toBeNull();
    err.mockRestore();
  });
});
