import { describe, expect, it, vi } from "vitest";
import {
  AiFlowValidationError,
  parseAiFlowDefinition
} from "@/lib/ai-flows/schema";
import { varsProducedByStep } from "@/lib/ai-flows/tree";
import type { FlowStep as UiFlowStep } from "@/lib/ai-flows/schema";
import {
  CALL_NOT_PLACED_SENTINEL,
  planStep
} from "../supabase/functions/_shared/ai_flows/steps";
import { simulateTestAction } from "../supabase/functions/_shared/ai_flows/test_mode";
import { resumeFlowRunWithCallOutcome } from "../supabase/functions/_shared/ai_flows/call_outcome";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * place_ai_call: a batch flow places an outbound AI call (with optional live
 * transfer) and parks until the outcome lands. These tests pin the authoring
 * validation, the pure planner, the test-run simulation, and the shared
 * run-resume writer the voice path uses.
 */

const EMP_REF = { source: "employee" as const, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Dave Lane" };

function defWith(step: Record<string, unknown>, extraSteps: Record<string, unknown>[] = []) {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      {
        id: "x1",
        type: "extract_text",
        fields: [{ name: "lead_phone" }, { name: "lead_name" }]
      },
      { id: "call1", type: "place_ai_call", ...step },
      ...extraSteps
    ]
  };
}

function issuesOf(input: unknown): string[] {
  try {
    parseAiFlowDefinition(input);
    return [];
  } catch (e) {
    if (e instanceof AiFlowValidationError) return e.issues;
    throw e;
  }
}

describe("schema: place_ai_call", () => {
  it("accepts a full step (transfer + pre-alert + captureFields) and registers the outcome var", () => {
    const def = parseAiFlowDefinition(
      defWith(
        {
          toVar: "lead_phone",
          personaTemplate: "Hi {{vars.lead_name}}, calling with Amy's office — good time?",
          notifyE164: "+16025245719",
          transfer: {
            toE164: "+16025245719",
            preSmsTemplate: "LIVE TRANSFER — {{vars.lead_name}} incoming, pick up!"
          },
          captureFields: ["best time to call"],
          saveAs: "call_outcome"
        },
        [
          {
            id: "after",
            type: "notify_owner",
            message: "Outcome: {{vars.call_outcome}}",
            when: { var: "call_outcome", notEquals: "transferred" }
          }
        ]
      )
    );
    expect(def.steps).toHaveLength(3);
  });

  it("defaults the outcome var to call_outcome for later steps (no explicit saveAs)", () => {
    const def = parseAiFlowDefinition(
      defWith(
        {
          toVar: "lead_phone",
          personaTemplate: "Hello!",
          notifyRef: EMP_REF
        },
        [{ id: "after", type: "notify_owner", message: "{{vars.call_outcome}}" }]
      )
    );
    expect(def.steps).toHaveLength(3);
  });

  it("rejects a toVar no earlier step produces", () => {
    const issues = issuesOf(
      defWith({ toVar: "mystery_phone", personaTemplate: "Hi", notifyE164: "+16025245719" })
    );
    expect(issues.join("\n")).toContain("calls {{vars.mystery_phone}}");
  });

  it("requires exactly one notify source", () => {
    expect(
      issuesOf(defWith({ toVar: "lead_phone", personaTemplate: "Hi" })).join("\n")
    ).toContain("nowhere to send the call summary");
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyE164: "+16025245719",
          notifyRef: EMP_REF
        })
      ).join("\n")
    ).toContain("both notifyE164 and notifyRef");
  });

  it("requires exactly one transfer target when a transfer is configured", () => {
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyE164: "+16025245719",
          transfer: {}
        })
      ).join("\n")
    ).toContain("live transfer with no target");
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyE164: "+16025245719",
          transfer: { toE164: "+16025245719", toRef: EMP_REF }
        })
      ).join("\n")
    ).toContain("both transfer.toE164 and transfer.toRef");
  });

  it("scope-checks the persona and pre-alert templates", () => {
    const issues = issuesOf(
      defWith({
        toVar: "lead_phone",
        personaTemplate: "Hi {{vars.never_extracted}}",
        notifyE164: "+16025245719",
        transfer: { toE164: "+16025245719", preSmsTemplate: "Alert {{vars.also_missing}}" }
      })
    );
    expect(issues.join("\n")).toContain("{{vars.never_extracted}}");
    expect(issues.join("\n")).toContain("{{vars.also_missing}}");
  });

  it("is a batch step: a voice flow may not contain it", () => {
    const issues = issuesOf({
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: [
        {
          id: "call1",
          type: "place_ai_call",
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyE164: "+16025245719"
        }
      ]
    });
    expect(issues.join("\n")).toContain("this is a voice flow");
  });
});

describe("tree: varsProducedByStep for place_ai_call", () => {
  const base = {
    id: "c1",
    type: "place_ai_call",
    toVar: "lead_phone",
    personaTemplate: "Hi",
    notifyE164: "+16025245719"
  } as unknown as UiFlowStep;
  it("registers the custom saveAs", () => {
    expect(varsProducedByStep({ ...base, saveAs: "attempt_1" } as UiFlowStep)).toEqual([
      "attempt_1"
    ]);
  });
  it("defaults to call_outcome", () => {
    expect(varsProducedByStep(base)).toEqual(["call_outcome"]);
  });
});

describe("planStep: place_ai_call", () => {
  const step = (extra: Record<string, unknown> = {}): FlowStep =>
    ({
      id: "call1",
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate: "Hi {{vars.lead_name}}, is now a good time?",
      notifyE164: "+16025245719",
      ...extra
    }) as FlowStep;

  it("resolves the callee (NANP normalized), renders persona + pre-alert, and passes refs through", () => {
    const plan = planStep(
      step({
        transfer: {
          toRef: EMP_REF,
          preSmsTemplate: "LIVE TRANSFER — {{vars.lead_name}} ({{vars.lead_phone}})"
        },
        captureFields: ["best time"],
        saveAs: "attempt_1"
      }),
      { vars: { lead_phone: "(757) 239-0150", lead_name: "Bryan" } }
    );
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "place_ai_call",
        to: "+17572390150",
        persona: "Hi Bryan, is now a good time?",
        notifyE164: "+16025245719",
        transferToRef: EMP_REF,
        preSmsBody: "LIVE TRANSFER — Bryan ((757) 239-0150)",
        captureFields: ["best time"],
        saveAs: "attempt_1",
        marker: "__called_call1"
      }
    });
  });

  it("keeps an already-E.164 callee, defaults saveAs, and carries a hardcoded transfer target", () => {
    const plan = planStep(
      step({ notifyE164: undefined, notifyRef: EMP_REF, transfer: { toE164: "+16025245719" } }),
      { vars: { lead_phone: "+17572390150", lead_name: "Bryan" } }
    );
    expect(plan.ok && plan.action.kind === "place_ai_call" ? plan.action : null).toMatchObject({
      to: "+17572390150",
      notifyRef: EMP_REF,
      transferToE164: "+16025245719",
      preSmsBody: "",
      saveAs: "call_outcome"
    });
  });

  it("re-entry after the marker is stamped is a no-op (never dials twice)", () => {
    const plan = planStep(step(), {
      vars: { lead_phone: "+17572390150", __called_call1: "1" }
    });
    expect(plan).toEqual({ ok: true, action: { kind: "set_vars", vars: {} } });
  });

  it("plans a SKIP for a missing or unusable callee phone (lead-data gap)", () => {
    for (const vars of [{}, { lead_phone: "call me maybe" }]) {
      const plan = planStep(step(), { vars: { ...vars, lead_name: "B" } });
      expect(plan.ok && plan.action.kind === "place_ai_call" && plan.action.skipReason).toBe(
        "no_callee_phone"
      );
      expect(plan.ok && plan.action.kind === "place_ai_call" && plan.action.to).toBe("");
    }
  });

  it("fails when the call script renders empty", () => {
    const plan = planStep(step({ personaTemplate: "{{vars.never_set}}" }), {
      vars: { lead_phone: "+17572390150" }
    });
    expect(plan).toEqual({
      ok: false,
      error: "place_ai_call: call script is empty after templating"
    });
  });
});

describe("test mode: place_ai_call is simulated", () => {
  const baseAction = {
    kind: "place_ai_call" as const,
    to: "+17572390150",
    persona: "Hi!",
    notifyE164: "+16025245719",
    preSmsBody: "",
    saveAs: "call_outcome",
    marker: "__called_call1"
  };

  it("a transfer-configured call resolves as transferred (hardcoded target)", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const result = simulateTestAction(
      { ...baseAction, transferToE164: "+16025245719", preSmsBody: "pick up!" },
      scope
    );
    expect(result).toEqual({
      simulated: "place_ai_call",
      to: "+17572390150",
      persona: "Hi!",
      pre_alert: "pick up!",
      saved: { call_outcome: "transferred" }
    });
    expect(scope.vars.call_outcome).toBe("transferred");
    expect(scope.vars.__called_call1).toBe("1");
  });

  it("a transfer-configured call resolves as transferred (ref target)", () => {
    const scope = { vars: {} as Record<string, unknown> };
    simulateTestAction({ ...baseAction, transferToRef: EMP_REF }, scope);
    expect(scope.vars.call_outcome).toBe("transferred");
  });

  it("a plain call resolves as answered", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const result = simulateTestAction(baseAction, scope);
    expect(result).toMatchObject({ saved: { call_outcome: "answered" } });
    expect(result).not.toHaveProperty("pre_alert");
    expect(scope.vars.call_outcome).toBe("answered");
  });

  it("a planner skip mirrors the live not_placed sentinel", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const result = simulateTestAction({ ...baseAction, skipReason: "no_callee_phone" }, scope);
    expect(result).toEqual({ simulated: "place_ai_call", skipped: "no_callee_phone" });
    expect(scope.vars.call_outcome).toBe(CALL_NOT_PLACED_SENTINEL);
    expect(scope.vars.__called_call1).toBe("1");
  });
});

// ── resumeFlowRunWithCallOutcome (shared voice-path resume writer) ──────────

type Scripted = { data?: unknown; error?: unknown };

/** Chainable fake supabase: pops one scripted result per terminal await. */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ table, name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const LINK = { run_id: "run-1", save_as: "attempt_1", marker: "__called_c1", step_index: 4 };

function parkedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "awaiting_call",
    context: {
      vars: { lead_phone: "+17572390150" },
      waiting_call: { step_index: 4, save_as: "attempt_1", marker: "__called_c1" }
    },
    revision: 7,
    ...overrides
  };
}

describe("resumeFlowRunWithCallOutcome", () => {
  it("writes the outcome + marker, stamps waiting_call.result, and re-queues", async () => {
    const { db, calls } = makeDb([
      { data: parkedRun(), error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    const ok = await resumeFlowRunWithCallOutcome(db, LINK, "transferred");
    expect(ok).toBe(true);
    const update = calls.find((c) => c.name === "update")!.args[0] as Record<string, unknown>;
    expect(update.status).toBe("queued");
    expect(update.respond_by_at).toBeNull();
    const ctx = update.context as {
      vars: Record<string, unknown>;
      waiting_call: Record<string, unknown>;
    };
    expect(ctx.vars.attempt_1).toBe("transferred");
    expect(ctx.vars.__called_c1).toBe("1");
    expect(ctx.vars.lead_phone).toBe("+17572390150");
    expect(ctx.waiting_call.result).toBe("transferred");
    // Revision + status guarded write (first writer wins).
    const eqs = calls.filter((c) => c.name === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["revision", 7]);
    expect(eqs).toContainEqual(["status", "awaiting_call"]);
  });

  it("defaults save_as/marker when the link omits them and tolerates a bare context", async () => {
    const { db, calls } = makeDb([
      { data: parkedRun({ context: null }), error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    const ok = await resumeFlowRunWithCallOutcome(db, { run_id: "run-1" }, "no_answer");
    expect(ok).toBe(true);
    const update = calls.find((c) => c.name === "update")!.args[0] as Record<string, unknown>;
    const ctx = update.context as { vars: Record<string, unknown> };
    expect(ctx.vars.call_outcome).toBe("no_answer");
    expect(ctx.vars.__called_unknown).toBe("1");
  });

  it("returns false without a run id", async () => {
    const { db, calls } = makeDb([]);
    expect(await resumeFlowRunWithCallOutcome(db, null, "answered")).toBe(false);
    expect(await resumeFlowRunWithCallOutcome(db, {}, "answered")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false on lookup error / missing run / wrong status", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db: dbErr } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await resumeFlowRunWithCallOutcome(dbErr, LINK, "answered")).toBe(false);
    const { db: dbMissing } = makeDb([{ data: null, error: null }]);
    expect(await resumeFlowRunWithCallOutcome(dbMissing, LINK, "answered")).toBe(false);
    const { db: dbDone } = makeDb([{ data: parkedRun({ status: "done" }), error: null }]);
    expect(await resumeFlowRunWithCallOutcome(dbDone, LINK, "answered")).toBe(false);
    err.mockRestore();
  });

  it("returns false when the parked step is not the one this call was placed for", async () => {
    const { db } = makeDb([
      {
        data: parkedRun({ context: { vars: {}, waiting_call: { step_index: 9 } } }),
        error: null
      }
    ]);
    expect(await resumeFlowRunWithCallOutcome(db, LINK, "answered")).toBe(false);
  });

  it("proceeds when either side lacks a numeric step index (defensive)", async () => {
    const { db } = makeDb([
      { data: parkedRun({ context: { vars: {}, waiting_call: {} } }), error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    expect(
      await resumeFlowRunWithCallOutcome(db, { ...LINK, step_index: undefined }, "answered")
    ).toBe(true);
  });

  it("returns false when the guarded update errors or matches nothing (race lost)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db: dbUpdErr } = makeDb([
      { data: parkedRun(), error: null },
      { data: null, error: { message: "conflict" } }
    ]);
    expect(await resumeFlowRunWithCallOutcome(dbUpdErr, LINK, "answered")).toBe(false);
    const { db: dbRace } = makeDb([
      { data: parkedRun(), error: null },
      { data: [], error: null }
    ]);
    expect(await resumeFlowRunWithCallOutcome(dbRace, LINK, "answered")).toBe(false);
    // PostgREST can also report "matched nothing" as data: null.
    const { db: dbNull } = makeDb([
      { data: parkedRun(), error: null },
      { data: null, error: null }
    ]);
    expect(await resumeFlowRunWithCallOutcome(dbNull, LINK, "answered")).toBe(false);
    err.mockRestore();
  });

  it("never throws: a client blow-up returns false", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await resumeFlowRunWithCallOutcome(db, LINK, "answered")).toBe(false);
    err.mockRestore();
  });
});
