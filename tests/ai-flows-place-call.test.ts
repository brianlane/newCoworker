import { describe, expect, it, vi } from "vitest";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  validateDefinitionSemantics
} from "@/lib/ai-flows/schema";
import { varsProducedByStep } from "@/lib/ai-flows/tree";
import type { FlowStep as UiFlowStep } from "@/lib/ai-flows/schema";
import {
  CALL_NOT_PLACED_SENTINEL,
  planStep,
  stepOverridesFlowTimeWindow
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
          personaTemplate: "Hi {{vars.lead_name}}, calling with Amy's office: good time?",
          notifyE164: "+16025245719",
          transfer: {
            toE164: "+16025245719",
            preSmsTemplate: "LIVE TRANSFER: {{vars.lead_name}} incoming, pick up!"
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
    ).toContain("more than one call-summary recipient");
  });

  /**
   * notifyOwner is the tenant-neutral recipient: without it a shared starter
   * template could not carry a call step at all (both other sources bake in a
   * tenant's phone or row id).
   */
  it("accepts notifyOwner as the sole summary recipient", () => {
    const def = parseAiFlowDefinition(
      defWith({ toVar: "lead_phone", personaTemplate: "Hi", notifyOwner: true })
    );
    expect(def.steps[1]).toMatchObject({ notifyOwner: true });
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects notifyOwner combined with either explicit recipient", () => {
    for (const extra of [{ notifyE164: "+16025245719" }, { notifyRef: EMP_REF }]) {
      expect(
        issuesOf(
          defWith({ toVar: "lead_phone", personaTemplate: "Hi", notifyOwner: true, ...extra })
        ).join("\n")
      ).toContain("more than one call-summary recipient");
    }
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
    // One handoff style per step: the two are different call topologies, and
    // a step carrying both is ambiguous about what the transfer tool does.
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyE164: "+16025245719",
          transfer: { toE164: "+16025245719" },
          reachTeammate: { refs: [EMP_REF] }
        })
      ).join("\n")
    ).toContain("one handoff style per call step");
    // notifyFirstReachTarget is the fourth exactly-one notify source and
    // only means something with a ladder.
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyE164: "+16025245719",
          notifyFirstReachTarget: true,
          reachTeammate: { refs: [EMP_REF] }
        })
      ).join("\n")
    ).toContain("more than one call-summary recipient");
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyFirstReachTarget: true
        })
      ).join("\n")
    ).toContain("no reachTeammate ladder");
    // The rotation window must fit the ladder and hold employees only.
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyOwner: true,
          reachTeammate: { refs: [EMP_REF, EMP_REF], rotateFirst: 3 }
        })
      ).join("\n")
    ).toContain("only has 2");
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi",
          notifyOwner: true,
          reachTeammate: {
            refs: [{ source: "contact", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, EMP_REF],
            rotateFirst: 2
          }
        })
      ).join("\n")
    ).toContain("not a roster employee");
  });

  it("scope-checks the persona, known-details, and pre-alert templates", () => {
    const issues = issuesOf(
      defWith({
        toVar: "lead_phone",
        personaTemplate: "Hi {{vars.never_extracted}}",
        contextTemplate: "Name: {{vars.ctx_missing}}",
        notifyE164: "+16025245719",
        transfer: { toE164: "+16025245719", preSmsTemplate: "Alert {{vars.also_missing}}" }
      })
    );
    expect(issues.join("\n")).toContain("{{vars.never_extracted}}");
    expect(issues.join("\n")).toContain("{{vars.ctx_missing}}");
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
  // The reason/label companions are derived from the outcome var, so a step
  // with a custom saveAs gets its own pair rather than colliding with another
  // call step's in the same flow.
  it("registers the custom saveAs and its companions", () => {
    expect(varsProducedByStep({ ...base, saveAs: "attempt_1" } as UiFlowStep)).toEqual([
      "attempt_1",
      "attempt_1_reason",
      "attempt_1_label"
    ]);
  });
  it("defaults to call_outcome and its companions", () => {
    expect(varsProducedByStep(base)).toEqual([
      "call_outcome",
      "call_outcome_reason",
      "call_outcome_label"
    ]);
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

  it("resolves the callee (NANP normalized), renders persona + context + pre-alert, and passes refs through", () => {
    const plan = planStep(
      step({
        contextTemplate: "Their name: {{vars.lead_name}}.",
        transfer: {
          toRef: EMP_REF,
          preSmsTemplate: "LIVE TRANSFER: {{vars.lead_name}} ({{vars.lead_phone}})"
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
        contextNote: "Their name: Bryan.",
        notifyE164: "+16025245719",
        transferToRef: EMP_REF,
        preSmsBody: "LIVE TRANSFER: Bryan ((757) 239-0150)",
        captureFields: ["best time"],
        saveAs: "attempt_1",
        marker: "__called_call1"
      }
    });
  });

  it("carries the reach ladder through with a rendered pre-alert", () => {
    const plan = planStep(
      step({
        reachTeammate: {
          refs: [EMP_REF],
          ringSeconds: 15,
          preSmsTemplate: "Seller on the line NOW: {{vars.lead_name}}. Pick up!"
        }
      }),
      { vars: { lead_phone: "+17572390150", lead_name: "Bryan" } }
    );
    expect(plan.ok && plan.action.kind === "place_ai_call" ? plan.action : null).toMatchObject({
      reachRefs: [EMP_REF],
      reachRingSeconds: 15,
      reachPreSmsBody: "Seller on the line NOW: Bryan. Pick up!"
    });
  });

  it("a minimal reach ladder omits the optional keys and renders no pre-alert", () => {
    const plan = planStep(
      step({ reachTeammate: { refs: [EMP_REF] } }),
      { vars: { lead_phone: "+17572390150", lead_name: "Bryan" } }
    );
    const action = plan.ok && plan.action.kind === "place_ai_call" ? plan.action : null;
    expect(action).toMatchObject({ reachRefs: [EMP_REF], reachPreSmsBody: "" });
    expect(action).not.toHaveProperty("reachRingSeconds");
  });

  it("carries the rotation window and notify-follows-first through to the action", () => {
    const plan = planStep(
      step({
        notifyE164: undefined,
        notifyFirstReachTarget: true,
        reachTeammate: { refs: [EMP_REF], rotateFirst: 2 }
      }),
      { vars: { lead_phone: "+17572390150", lead_name: "Bryan" } }
    );
    expect(plan.ok && plan.action.kind === "place_ai_call" ? plan.action : null).toMatchObject({
      reachRotateFirst: 2,
      notifyFirstReachTarget: true
    });
  });

  it("omits both new keys when unset", () => {
    const plan = planStep(
      step({ reachTeammate: { refs: [EMP_REF] } }),
      { vars: { lead_phone: "+17572390150", lead_name: "Bryan" } }
    );
    const action = plan.ok && plan.action.kind === "place_ai_call" ? plan.action : null;
    expect(action).not.toHaveProperty("reachRotateFirst");
    expect(action).not.toHaveProperty("notifyFirstReachTarget");
  });

  it("carries notifyOwner through to the action (the worker resolves the number)", () => {
    const plan = planStep(
      step({ notifyE164: undefined, notifyOwner: true }),
      { vars: { lead_phone: "+17572390150", lead_name: "Bryan" } }
    );
    expect(plan.ok && plan.action.kind === "place_ai_call" ? plan.action : null).toMatchObject({
      notifyOwner: true
    });
    // Absence stays absent (no false "owner" default on existing flows).
    const without = planStep(step(), { vars: { lead_phone: "+17572390150" } });
    expect(
      without.ok && without.action.kind === "place_ai_call" && "notifyOwner" in without.action
    ).toBe(false);
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
      contextNote: "",
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
    contextNote: "",
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
    expect(result).not.toHaveProperty("known_details");
    expect(scope.vars.call_outcome).toBe("answered");
  });

  it("the simulated result surfaces the rendered known-details note", () => {
    const scope = { vars: {} as Record<string, unknown> };
    const result = simulateTestAction(
      { ...baseAction, contextNote: "Their name: Bryan." },
      scope
    );
    expect(result).toMatchObject({ known_details: "Their name: Bryan." });
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
    // A call that ends NORMALLY must set the same companion vars a refusal
    // does, or a template reading the label renders empty on the happy path.
    // Companions follow the step's own saveAs, not a fixed name.
    expect(ctx.vars.attempt_1_label).toBe("connected you live");
    expect(ctx.vars.attempt_1_reason).toBe("");
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
    expect(ctx.vars.call_outcome_label).toBe("no answer yet");
  });

  // A machine answering rides a no_answer outcome so ladders written before
  // AMD keep retrying; the REASON is what tells the owner it was a voicemail.
  it("sharpens the label from a reason when the caller supplies one", async () => {
    const { db, calls } = makeDb([
      { data: parkedRun(), error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    await resumeFlowRunWithCallOutcome(db, LINK, "no_answer", "voicemail_left");
    const update = calls.find((c) => c.name === "update")!.args[0] as Record<string, unknown>;
    const ctx = update.context as { vars: Record<string, unknown> };
    expect(ctx.vars.attempt_1).toBe("no_answer");
    expect(ctx.vars.attempt_1_reason).toBe("voicemail_left");
    expect(ctx.vars.attempt_1_label).toBe("left them a voicemail");
  });

  // A retry ladder can reuse one outcome var across attempts, so a later
  // attempt must never inherit the previous attempt's reason.
  it("overwrites a previous attempt's reason rather than leaving it stale", async () => {
    const stale = parkedRun();
    (stale.context as { vars: Record<string, unknown> }).vars.attempt_1_reason =
      "voicemail_left";
    const { db, calls } = makeDb([
      { data: stale, error: null },
      { data: [{ id: "run-1" }], error: null }
    ]);
    await resumeFlowRunWithCallOutcome(db, LINK, "answered");
    const update = calls.find((c) => c.name === "update")!.args[0] as Record<string, unknown>;
    const ctx = update.context as { vars: Record<string, unknown> };
    expect(ctx.vars.attempt_1_reason).toBe("");
    expect(ctx.vars.attempt_1_label).toBe("spoke with them");
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

/**
 * The per-step calling window and the park-ceiling override, both added when
 * `place_ai_call` became a first-contact step that dials on lead arrival and
 * retries rather than a manual/weekly one.
 */
describe("schema: place_ai_call calling window", () => {
  const withWindow = (callWindow: Record<string, unknown>) =>
    defWith({
      toVar: "lead_phone",
      personaTemplate: "Hi",
      notifyE164: "+16025245719",
      callWindow
    });

  it("accepts a window and round-trips outside/daysOfWeek", () => {
    const def = parseAiFlowDefinition(
      withWindow({
        timezone: "America/Phoenix",
        start: "08:30",
        end: "21:00",
        daysOfWeek: [1, 2, 3, 4, 5],
        outside: "skip"
      })
    );
    const step = def.steps[1] as Extract<UiFlowStep, { type: "place_ai_call" }>;
    expect(step.callWindow?.outside).toBe("skip");
    expect(step.callWindow?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  // Absent `outside` must mean defer: anything that has not explicitly opted
  // into trading the call away keeps the conservative behavior.
  it("leaves outside unset rather than defaulting it into the definition", () => {
    const def = parseAiFlowDefinition(
      withWindow({ timezone: "America/Phoenix", start: "08:30", end: "21:00" })
    );
    const step = def.steps[1] as Extract<UiFlowStep, { type: "place_ai_call" }>;
    expect(step.callWindow?.outside).toBeUndefined();
  });

  it("rejects a zero-length window", () => {
    expect(
      issuesOf(withWindow({ timezone: "America/Phoenix", start: "09:00", end: "09:00" })).join(" ")
    ).toMatch(/start and end at the same time/);
  });

  it("rejects a malformed time and an unknown outside mode", () => {
    expect(
      issuesOf(withWindow({ timezone: "America/Phoenix", start: "8:30", end: "21:00" })).length
    ).toBeGreaterThan(0);
    expect(
      issuesOf({
        ...withWindow({
          timezone: "America/Phoenix",
          start: "08:30",
          end: "21:00",
          outside: "email"
        })
      }).length
    ).toBeGreaterThan(0);
  });
});

describe("schema: place_ai_call waitMinutes", () => {
  const withExtras = (extra: Record<string, unknown>) =>
    defWith({
      toVar: "lead_phone",
      personaTemplate: "Hi",
      notifyE164: "+16025245719",
      ...extra
    });

  it("clamps waitMinutes to the supported range", () => {
    expect(parseAiFlowDefinition(withExtras({ waitMinutes: 20 }))).toBeTruthy();
    expect(issuesOf(withExtras({ waitMinutes: 4 })).length).toBeGreaterThan(0);
    expect(issuesOf(withExtras({ waitMinutes: 46 })).length).toBeGreaterThan(0);
  });
});

describe("planStep: place_ai_call passes the window and wait through", () => {
  const step = (extra: Record<string, unknown> = {}): FlowStep =>
    ({
      id: "call1",
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate: "Hi {{vars.lead_name}}",
      notifyE164: "+16025245719",
      ...extra
    }) as FlowStep;
  const scope = { vars: { lead_phone: "+16025550123", lead_name: "Sarah" } };

  it("passes callWindow and waitMinutes through to the worker", () => {
    const callWindow = {
      timezone: "America/Phoenix",
      start: "08:30",
      end: "21:00",
      outside: "skip" as const
    };
    const plan = planStep(step({ callWindow, waitMinutes: 20 }), scope);
    if (!plan.ok || plan.action.kind !== "place_ai_call") throw new Error("expected a call plan");
    expect(plan.action.callWindow).toEqual(callWindow);
    expect(plan.action.waitMinutes).toBe(20);
  });

  it("omits both when unset, so the worker keeps its defaults", () => {
    const plan = planStep(step(), scope);
    if (!plan.ok || plan.action.kind !== "place_ai_call") throw new Error("expected a call plan");
    expect(plan.action.callWindow).toBeUndefined();
    expect(plan.action.waitMinutes).toBeUndefined();
  });
});

/**
 * Precedence between the flow-level `timeWindow` and a step's own
 * `callWindow`. Without this rule the per-step "skip" mode is dead code on any
 * flow that also has business hours: the flow window defers the whole run
 * first, and the step never gets to decide.
 */
describe("stepOverridesFlowTimeWindow", () => {
  const call = (extra: Record<string, unknown> = {}): FlowStep =>
    ({
      id: "call1",
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate: "Hi",
      notifyE164: "+16025245719",
      ...extra
    }) as FlowStep;
  const WINDOW = { timezone: "America/Phoenix", start: "08:30", end: "21:00" };

  it("stands the flow window aside for a call that sets its own hours", () => {
    expect(stepOverridesFlowTimeWindow(call({ callWindow: WINDOW }))).toBe(true);
    expect(
      stepOverridesFlowTimeWindow(call({ callWindow: { ...WINDOW, outside: "skip" } }))
    ).toBe(true);
    // "defer" is still an override: the STEP's hours are the ones that apply,
    // even though the effect happens to match the flow window's behavior.
    expect(
      stepOverridesFlowTimeWindow(call({ callWindow: { ...WINDOW, outside: "defer" } }))
    ).toBe(true);
  });

  it("leaves a call with no window of its own fully under the flow window", () => {
    expect(stepOverridesFlowTimeWindow(call())).toBe(false);
  });

  // Narrow by design: no other step type gains an exemption from this.
  it("never exempts another step type", () => {
    for (const type of ["send_sms", "send_email", "notify_owner", "route_to_team"]) {
      expect(
        stepOverridesFlowTimeWindow({ id: "s", type, callWindow: WINDOW } as unknown as FlowStep)
      ).toBe(false);
    }
  });
});

/**
 * Voicemail. AMD shipped in #1214 as detect-and-hang-up: a machine picking up
 * resolved the step `no_answer` / `voicemail_no_message` and the leg was cut,
 * because half a conversation into a recording is worse than none. These pin
 * the message half, the step may now say something, and only when it was
 * given something to say.
 */
describe("place_ai_call: voicemailTemplate", () => {
  it("accepts a voicemail message and scope-checks its vars like any other template", () => {
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi {{vars.lead_name}}, calling from Amy's office.",
          voicemailTemplate: "Hi {{vars.lead_name}}, Amy Laidlaw's office calling, we will try again.",
          notifyE164: "+16025245719"
        })
      )
    ).toEqual([]);
    // A var no earlier step produces would reach a stranger's voicemail as a
    // gap mid-sentence, with nothing to catch it at author time.
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi there.",
          voicemailTemplate: "Calling about {{vars.lead_addres}}.",
          notifyE164: "+16025245719"
        })
      ).some((i) => i.includes("{{vars.lead_addres}} before any step produces it"))
    ).toBe(true);
  });

  // The same omission that left unclaimedReminders.detailsTemplate unchecked.
  it("scope-checks the reach ladder's pre-alert too", () => {
    expect(
      issuesOf(
        defWith({
          toVar: "lead_phone",
          personaTemplate: "Hi there.",
          notifyFirstReachTarget: true,
          reachTeammate: { refs: [EMP_REF], preSmsTemplate: "Incoming: {{vars.lead_nam}}" }
        })
      ).some((i) => i.includes("{{vars.lead_nam}} before any step produces it"))
    ).toBe(true);
  });

  it("renders the message into the plan, and drops it when every var came back empty", () => {
    const step = {
      id: "call1",
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate: "Hi {{vars.lead_name}}.",
      voicemailTemplate: "{{vars.lead_name}}",
      notifyE164: "+16025245719",
      saveAs: "call_outcome"
    } as unknown as FlowStep;
    const withName = planStep(step, { vars: { lead_phone: "+14805551212", lead_name: "Marla" } });
    expect(
      withName.ok && withName.action.kind === "place_ai_call" ? withName.action : null
    ).toMatchObject({ voicemailScript: "Marla" });
    // Nothing to say is not the same as saying nothing: an all-empty render
    // must fall back to hanging up, not speak silence at a recording.
    const empty = planStep(step, { vars: { lead_phone: "+14805551212" } });
    expect(
      empty.ok && empty.action.kind === "place_ai_call" && "voicemailScript" in empty.action
    ).toBe(false);
  });

  it("omits the script entirely when the step configured none", () => {
    const plan = planStep(
      {
        id: "call1",
        type: "place_ai_call",
        toVar: "lead_phone",
        personaTemplate: "Hi.",
        notifyE164: "+16025245719",
        saveAs: "call_outcome"
      } as unknown as FlowStep,
      { vars: { lead_phone: "+14805551212" } }
    );
    expect(
      plan.ok && plan.action.kind === "place_ai_call" && "voicemailScript" in plan.action
    ).toBe(false);
  });
});
