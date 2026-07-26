import { describe, expect, it } from "vitest";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  validateDefinitionSemantics
} from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import {
  capturedCallVars,
  capturedSpoken,
  capturedVarSuffix
} from "../supabase/functions/_shared/ai_flows/call_capture";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

const PARTNER = "+14159851909";

const waitFlow = (step: Record<string, unknown>, trailing: Record<string, unknown>[] = []) => ({
  version: 1,
  trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
  steps: [
    { id: "wait", type: "wait_for_call", fromE164: PARTNER, ...step },
    ...trailing
  ]
});

describe("wait_for_call: authoring", () => {
  it("accepts the minimal shape", () => {
    const def = parseAiFlowDefinition(waitFlow({}));
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("requires an E.164 partner line", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
        steps: [{ id: "wait", type: "wait_for_call", fromE164: "4159851909" }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("publishes the captured fields so later steps can template them", () => {
    // The whole point of the step is that the follow-up can USE what the AI got
    // out of the person, so a send referencing them must validate.
    const def = parseAiFlowDefinition(
      waitFlow({}, [
        {
          id: "tell_dave",
          type: "send_sms",
          to: "+16025551234",
          body: "Seller said {{vars.call_phone}} ({{vars.call_name}}) at {{vars.call_address}}"
        }
      ])
    );
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("honours a custom capturePrefix when publishing them", () => {
    const def = parseAiFlowDefinition(
      waitFlow({ capturePrefix: "spoken_" }, [
        {
          id: "tell_dave",
          type: "send_sms",
          to: "+16025551234",
          body: "Seller said {{vars.spoken_phone}}"
        }
      ])
    );
    expect(validateDefinitionSemantics(def)).toEqual([]);
    // ...and the DEFAULT prefix is no longer in scope, so a copy/paste from
    // another flow fails at save time instead of rendering blank on a live lead.
    expect(() =>
      parseAiFlowDefinition(
        waitFlow({ capturePrefix: "spoken_" }, [
          {
            id: "tell_dave",
            type: "send_sms",
            to: "+16025551234",
            body: "Seller said {{vars.call_phone}}"
          }
        ])
      )
    ).toThrow(AiFlowValidationError);
  });

  it("publishes the outcome var for a later branch", () => {
    const def = parseAiFlowDefinition(
      waitFlow({ saveAs: "hl_call" }, [
        {
          id: "note",
          type: "notify_owner",
          message: "Call outcome: {{vars.hl_call}}",
          when: { var: "hl_call", equals: "no_call" }
        }
      ])
    );
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("accepts a backfill mapping and registers its target", () => {
    // The contact record and the customer's intro text need ONE number, and the
    // partner may never supply one, so the spoken value has to be able to fill
    // the flow's canonical var.
    const def = parseAiFlowDefinition(
      waitFlow({ backfill: [{ from: "phone", to: "lead_phone" }] }, [
        {
          id: "save",
          type: "upsert_customer",
          phoneVar: "lead_phone",
          nameVar: "call_name"
        }
      ])
    );
    expect(validateDefinitionSemantics(def)).toEqual([]);
  });

  it("rejects a backfill that names an illegal var", () => {
    expect(() =>
      parseAiFlowDefinition(waitFlow({ backfill: [{ from: "phone", to: "Lead Phone" }] }))
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition(waitFlow({ backfill: [{ from: "Phone!", to: "lead_phone" }] }))
    ).toThrow(AiFlowValidationError);
  });

  it("is rejected inside a voice flow (it parks the batch worker)", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "voice" },
        steps: [{ id: "wait", type: "wait_for_call", fromE164: PARTNER }]
      })
    ).toThrow(AiFlowValidationError);
  });
});

describe("wait_for_call: planning", () => {
  const plan = (step: Record<string, unknown>, vars: Record<string, unknown> = {}) =>
    planStep({ id: "wait", type: "wait_for_call", fromE164: PARTNER, ...step } as FlowStep, {
      vars,
      trigger: {}
    } as never);

  it("defaults the window, timeout, outcome var and prefix", () => {
    const p = plan({});
    expect(p.ok).toBe(true);
    expect(p.ok && p.action).toMatchObject({
      kind: "wait_for_call",
      fromE164: PARTNER,
      withinMinutes: 30,
      timeoutMinutes: 60,
      saveAs: "call_outcome",
      capturePrefix: "call_",
      backfill: [],
      resumed: false
    });
  });

  it("passes a backfill mapping through, dropping half-written entries", () => {
    const p = plan({
      backfill: [
        { from: "phone", to: "lead_phone" },
        { from: "", to: "lead_name" }
      ]
    });
    expect(p.ok && (p.action as { backfill: unknown }).backfill).toEqual([
      { from: "phone", to: "lead_phone" }
    ]);
  });

  it("clamps an out-of-range window and timeout rather than refusing", () => {
    const p = plan({ withinMinutes: 9999, timeoutMinutes: 99999 });
    expect(p.ok && p.action).toMatchObject({ withinMinutes: 120, timeoutMinutes: 1440 });
  });

  it("reports the return trip so the worker hydrates instead of parking twice", () => {
    // Unlike place_ai_call the marker does NOT short-circuit the step: coming
    // back from the park is exactly when the captured fields exist to be read.
    const p = plan({}, { __waited_call_wait: "1" });
    expect(p.ok && p.action).toMatchObject({ kind: "wait_for_call", resumed: true });
  });

  it("keys the marker per step, so two waits in one flow are independent", () => {
    const other = planStep(
      { id: "wait2", type: "wait_for_call", fromE164: PARTNER } as FlowStep,
      { vars: { __waited_call_wait: "1" }, trigger: {} } as never
    );
    expect(other.ok && other.action).toMatchObject({ resumed: false });
  });
});

describe("capturedCallVars", () => {
  const NONE = {
    call_name: "none",
    call_phone: "none",
    call_email: "none",
    call_address: "none",
    call_timeframe: "none",
    call_notes: "none"
  };

  it("namespaces what the AI captured", () => {
    expect(capturedCallVars({ name: "Duane", phone: "+16025550100" }, "call_")).toEqual({
      ...NONE,
      call_name: "Duane",
      call_phone: "+16025550100"
    });
  });

  it('publishes "none" for what the AI did not get, so a label never dangles', () => {
    // A team text reading "Seller said on the call: " is the failure this
    // avoids, and `notEquals: "none"` needs a real value to test against.
    expect(capturedCallVars({ phone: "   ", name: "Duane" }, "call_")).toEqual({
      ...NONE,
      call_name: "Duane"
    });
    expect(capturedCallVars(null, "call_")).toEqual(NONE);
    expect(capturedCallVars(undefined, "call_")).toEqual(NONE);
    expect(capturedCallVars({ phone: 42 } as never, "call_")).toEqual(NONE);
  });

  it("normalizes owner-authored capture-field names into legal vars", () => {
    // captureFields is free text ("reason for calling"), so it cannot be
    // trusted to already be var-shaped.
    expect(capturedCallVars({ "Reason For Calling!": "downsizing" }, "call_")).toEqual({
      ...NONE,
      call_reason_for_calling: "downsizing"
    });
    expect(capturedVarSuffix("  --  ")).toBe("");
    expect(capturedCallVars({ "!!": "x" }, "call_")).toEqual(NONE);
  });

  it("capturedSpoken reads through the none sentinel", () => {
    const vars = capturedCallVars({ phone: "+16025550100" }, "call_");
    expect(capturedSpoken(vars, "call_", "phone")).toBe("+16025550100");
    expect(capturedSpoken(vars, "call_", "email")).toBe("");
    expect(capturedSpoken({}, "call_", "phone")).toBe("");
  });
});
