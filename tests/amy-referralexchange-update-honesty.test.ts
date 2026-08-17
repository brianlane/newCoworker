import { describe, it, expect } from "vitest";
import {
  GATE_STEP_ID,
  OUTCOME_VAR,
  REACHED_ARMS,
  SPOKE_NOTE,
  STATUS_IN_CONTACT,
  STATUS_NO_INTERACTION,
  SUBSTATUS_OPEN,
  UPDATE_STEP_ID,
  addUpdateHonestyGate,
  allStepIds,
  buildHonestUpdate,
  spokeActions
} from "../scripts/oneshot/amy-referralexchange-update-honesty-definition";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the ReferralExchange status-honesty gate.
 *
 * The live flow could place an AI call, have it answered or warm-transferred,
 * and then post "No interaction yet / I am still trying to contact" to the
 * referral timeline in the same run. ReferralExchange sets referral quality and
 * volume from these updates.
 *
 * The modal's real option tree was read live on 2026-08-17 and is asserted here,
 * because every one of these strings is a click target: a reworded label breaks
 * the submit silently, and this is the file that should fail first.
 */

/** The live `re_update` step (486375c4), verbatim. */
function liveUpdateStep(): Record<string, unknown> {
  return {
    id: UPDATE_STEP_ID,
    type: "browse_action",
    urlVar: "leadUrl",
    auth: { integrationLabel: "Referral Exchange" },
    actions: [
      { kind: "click_text", target: "Leave an update" },
      { kind: "click_text", target: STATUS_NO_INTERACTION },
      { kind: "click_text", target: "I am still trying to contact" },
      {
        kind: "fill_selector",
        target: 'textarea[name="message"]',
        valueTemplate:
          "Update from Amy's assistant: {{vars.actions_taken}}. Will keep following up."
      },
      { kind: "click_selector", target: ".update-status-container .submit.action-details button" }
    ],
    screenshot: true
  };
}

/** A trunk shaped like the live flow: an AI call arm, then the update, then a notify. */
function liveish(): AiFlowDefinition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [{ type: "has_url" }, { type: "contains", value: "ReferralExchange" }]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "browse",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Referral Exchange" },
        fields: [
          { name: "lead_type", description: "buyer, seller or both" },
          { name: "lead_phone", description: "the client phone, or none" },
          { name: "lead_name", description: "the client name" }
        ]
      },
      {
        id: "ai_first_contact",
        type: "branch",
        question: "Which script should the AI call use?",
        branches: [
          {
            id: "ai_call_seller_arm",
            label: "seller",
            condition: { var: "lead_type", equals: "seller" },
            steps: [
              {
                id: "ai_call_seller",
                type: "place_ai_call",
                toVar: "lead_phone",
                personaTemplate: "Call {{vars.lead_name}} about the listing.",
                notifyOwner: true,
                saveAs: OUTCOME_VAR
              }
            ]
          }
        ],
        else: []
      },
      liveUpdateStep(),
      { id: "notify", type: "notify_owner", message: "RE lead handled: {{vars.actions_taken}}" }
    ]
  } as unknown as AiFlowDefinition;
}

function stepById(def: AiFlowDefinition, id: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  const walk = (steps: readonly unknown[]): void => {
    for (const s of steps as Array<Record<string, unknown>>) {
      if (s.id === id) found = s;
      for (const arm of (s.branches as Array<{ steps?: unknown[] }>) ?? []) walk(arm.steps ?? []);
      walk((s.else as unknown[]) ?? []);
    }
  };
  walk(def.steps);
  return found;
}

describe("the modal labels this clicks", () => {
  it("uses the verbatim parent status, which is the whole point of the change", () => {
    expect(STATUS_IN_CONTACT).toBe("We are in contact");
    expect(STATUS_NO_INTERACTION).toBe("No interaction yet");
  });

  it("matches the sub-option by a fragment, because the label carries a first name", () => {
    // The live label is "<FirstName> is open to working with me". Matching the
    // whole thing would need the lead's first name, which the flow does not
    // carry as its own var.
    expect(SUBSTATUS_OPEN).toBe("is open to working with me");
    expect(SUBSTATUS_OPEN.startsWith("is ")).toBe(true);
  });

  it("never claims an appointment or a refusal, which are the other two options", () => {
    const actions = JSON.stringify(spokeActions());
    expect(actions).not.toMatch(/appointment/i);
    expect(actions).not.toMatch(/does not want/i);
  });

  it("still submits through the same control the working step uses", () => {
    const submit = spokeActions().at(-1);
    expect(submit).toEqual({
      kind: "click_selector",
      target: ".update-status-container .submit.action-details button"
    });
  });

  it("picks a status BEFORE typing, since the submit stays disabled without one", () => {
    const kinds = spokeActions().map((a) => `${a.kind}:${a.target}`);
    expect(kinds.indexOf(`click_text:${STATUS_IN_CONTACT}`)).toBeLessThan(
      kinds.indexOf('fill_selector:textarea[name="message"]')
    );
    expect(kinds.indexOf(`click_text:${SUBSTATUS_OPEN}`)).toBeLessThan(
      kinds.indexOf('fill_selector:textarea[name="message"]')
    );
  });

  it("selects the sub-option after its parent, which is what reveals it", () => {
    const kinds = spokeActions().map((a) => a.target);
    expect(kinds.indexOf(STATUS_IN_CONTACT)).toBeLessThan(kinds.indexOf(SUBSTATUS_OPEN));
  });
});

describe("addUpdateHonestyGate", () => {
  it("wraps the update in a branch at the same trunk position", () => {
    const def = liveish();
    const before = def.steps.map((s) => s.id);
    const added = addUpdateHonestyGate(def);

    expect(added).toEqual([GATE_STEP_ID, ...REACHED_ARMS.map((a) => a.stepId)]);
    expect(def.steps.map((s) => s.id)).toEqual(
      before.map((id) => (id === UPDATE_STEP_ID ? GATE_STEP_ID : id))
    );
  });

  it("keeps re_update alive under its own id, so a parked run still resumes", () => {
    // resolveResumeIndex stops a run whose stored cursor id has vanished. This
    // is the assertion that makes the change safe to apply to a live flow.
    const def = liveish();
    addUpdateHonestyGate(def);
    expect(allStepIds(def)).toContain(UPDATE_STEP_ID);
  });

  it("leaves re_update byte-for-byte unchanged on the else path", () => {
    const def = liveish();
    const before = liveUpdateStep();
    addUpdateHonestyGate(def);
    const gate = stepById(def, GATE_STEP_ID) as { else: unknown[] };
    expect(gate.else).toEqual([before]);
  });

  it("does not grow the trunk, which on the live flow sits 3 short of the cap", () => {
    const def = liveish();
    const before = def.steps.length;
    addUpdateHonestyGate(def);
    expect(def.steps).toHaveLength(before);
  });

  it("answers to both reached outcomes, by equality, the way the flow already does", () => {
    const def = liveish();
    addUpdateHonestyGate(def);
    const gate = stepById(def, GATE_STEP_ID) as {
      branches: Array<{ id: string; condition: Record<string, string> }>;
    };
    expect(gate.branches.map((b) => b.condition)).toEqual([
      { var: OUTCOME_VAR, equals: "answered" },
      { var: OUTCOME_VAR, equals: "transferred" }
    ]);
  });

  it("never gates negatively, because a skipped call is not_placed", () => {
    // A call the calling window skipped resolves to `not_placed`, not
    // `no_answer`, so `notEquals: "no_answer"` would post "we are in contact"
    // for a call that was never dialed.
    const def = liveish();
    addUpdateHonestyGate(def);
    const gate = stepById(def, GATE_STEP_ID) as { branches: Array<{ condition: object }> };
    for (const arm of gate.branches) expect(arm.condition).not.toHaveProperty("notEquals");
  });

  it("gives both arms the same actions, so they cannot drift apart", () => {
    const def = liveish();
    addUpdateHonestyGate(def);
    const [a, b] = REACHED_ARMS.map(
      (arm) => (stepById(def, arm.stepId) as { actions: unknown }).actions
    );
    expect(a).toEqual(b);
    expect(a).toEqual(spokeActions());
  });

  it("carries the original step's credential and url var into both arms", () => {
    const def = liveish();
    addUpdateHonestyGate(def);
    for (const arm of REACHED_ARMS) {
      const step = stepById(def, arm.stepId) as { auth: unknown; urlVar: string };
      expect(step.auth).toEqual({ integrationLabel: "Referral Exchange" });
      expect(step.urlVar).toBe("leadUrl");
    }
  });

  it("screenshots the reached update, which is the evidence it posted", () => {
    const def = liveish();
    addUpdateHonestyGate(def);
    for (const arm of REACHED_ARMS) {
      expect((stepById(def, arm.stepId) as { screenshot: boolean }).screenshot).toBe(true);
    }
  });

  it("is idempotent", () => {
    const def = liveish();
    addUpdateHonestyGate(def);
    const after = allStepIds(def);
    expect(addUpdateHonestyGate(def)).toEqual([]);
    expect(allStepIds(def)).toEqual(after);
  });

  it("refuses loudly when re_update is not where it expects it", () => {
    // Silently reporting "already applied" would leave the flow understating
    // its status forever, which is the bug this exists to fix.
    const def = liveish();
    def.steps = def.steps.filter((s) => s.id !== UPDATE_STEP_ID);
    expect(() => addUpdateHonestyGate(def)).toThrow(/No trunk step "re_update"/);
  });
});

describe("the whole transform, as the applier will write it", () => {
  it("produces a definition the authoring validator accepts", () => {
    const { definition } = buildHonestUpdate(liveish());
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("does not mutate the live definition handed in", () => {
    const live = liveish();
    const snapshot = JSON.parse(JSON.stringify(live));
    buildHonestUpdate(live);
    expect(live).toEqual(snapshot);
  });

  it("keeps every step id unique after the wrap", () => {
    const ids = allStepIds(buildHonestUpdate(liveish()).definition);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still posts the understated status when the call was NOT answered", () => {
    // The else path is the honest answer for no_answer / not_placed / failed,
    // and for a lead with no phone at all.
    const { definition } = buildHonestUpdate(liveish());
    const original = stepById(definition, UPDATE_STEP_ID) as { actions: Array<{ target: string }> };
    expect(original.actions.map((a) => a.target)).toContain(STATUS_NO_INTERACTION);
  });

  it("posts a note that says what the run actually did", () => {
    expect(SPOKE_NOTE).toContain("{{vars.actions_taken}}");
    expect(SPOKE_NOTE).toMatch(/connected with the client by phone/);
  });
});
