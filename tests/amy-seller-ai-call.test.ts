import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  ATTEMPT_2_DELAY_MINUTES,
  ATTEMPT_3_TIME,
  BEST_TIME_CAPTURE_FIELD,
  CALL_WINDOW,
  CASH_OFFERS_FIELD,
  PITCH_CLEVER,
  PITCH_CONTEXT,
  PITCH_REFERRAL_EXCHANGE,
  addCashOffersField,
  addSellerCallLadder,
  hasSellerCallLadder,
  nextStepsLine,
  removeBestTimeCaptureField,
  withAiCallLines,
  type Ref
} from "../scripts/oneshot/amy-seller-ai-call-definition";

/**
 * Amy Laidlaw's seller auto-call ladder (the builders behind
 * amy-seller-ai-call-patch.ts). Everything here validates through the SAME
 * parser the dashboard uses, against a base flow shaped like the live ones,
 * so a schema change that would break the patched tenant flows breaks CI
 * first.
 *
 * The scripts are Amy's approved content: several assertions below pin her
 * explicit rules (the cash-offer angle is Clever-only, never ask when to
 * call back, no captureFields anywhere on a pitch call).
 */

const DAVE: Ref = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  label: "Dave Lane",
  source: "employee"
};

type Step = AiFlowDefinition["steps"][number];

/** A minimal stand-in for the live Clever flow: produce the vars, route, tail. */
function cleverBase(): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "Clever referral" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "page_url" },
      {
        id: "read_details",
        type: "browse_extract",
        integration: "Clever",
        instruction: "Read the lead page",
        urlVar: "page_url",
        fields: [
          { name: "lead_name", description: "name" },
          { name: "lead_phone", description: "phone" },
          { name: "lead_address", description: "address" },
          { name: "price", description: "price" },
          { name: "price_band", description: "over_1m or under_1m" }
        ]
      },
      {
        id: "route",
        type: "route_to_team",
        agentName: "Dave Lane",
        responseMinutes: 10,
        offerTemplate:
          "New Clever lead: {{vars.lead_name}} ({{vars.lead_phone}})\nReply 1 to claim or 2 to pass by {{offer.deadline}}.",
        ownerFallbackTemplate:
          "No one claimed {{vars.lead_name}}.\nReply 1 to claim or 2 to pass by {{offer.deadline}}.",
        claimedNotifyTemplate: "{{agent.name}} took {{vars.lead_name}}."
      },
      { id: "notify", type: "notify_owner", message: "done {{vars.lead_name}}" }
    ]
  };
}

/** The RefX stand-in adds the seller/type vars the gate reads. */
function refxBase(): Record<string, unknown> {
  const base = cleverBase();
  const read = (base.steps as Record<string, unknown>[])[1] as { fields: unknown[] };
  read.fields = [
    ...(read.fields as object[]),
    { name: "route_lead_type", description: "buyer/seller/both" },
    { name: "web_source", description: "site" }
  ];
  (base.steps as Record<string, unknown>[])[2].id = "route_seller";
  return base;
}

function walk(steps: readonly Step[], visit: (s: Step) => void): void {
  for (const s of steps) {
    visit(s);
    if (s.type === "branch") {
      for (const arm of s.branches) walk(arm.steps, visit);
      walk(s.else, visit);
    }
  }
}

function collectCalls(def: AiFlowDefinition) {
  const calls: Array<Extract<Step, { type: "place_ai_call" }>> = [];
  walk(def.steps, (s) => {
    if (s.type === "place_ai_call") calls.push(s);
  });
  return calls;
}

describe("addSellerCallLadder (Clever shape)", () => {
  const patched = () => {
    const def = cleverBase() as unknown as AiFlowDefinition;
    addCashOffersField(def);
    const changed = addSellerCallLadder(def, "clever", { dave: DAVE }, { routeStepId: "route" });
    return { def, changed };
  };

  it("parses through the real parser and lands in the promised order", () => {
    const { def, changed } = patched();
    expect(changed).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    expect(parsed.steps.map((s) => s.id)).toEqual([
      "url",
      "read_details",
      "ai_call_1",
      "route",
      "call_followups",
      "lead_reached",
      "notify"
    ]);
  });

  it("is a genuine no-op the second time", () => {
    const { def } = patched();
    expect(hasSellerCallLadder(def)).toBe(true);
    expect(addSellerCallLadder(def, "clever", { dave: DAVE }, { routeStepId: "route" })).toBe(
      false
    );
  });

  it("refuses a flow whose route step vanished", () => {
    const def = cleverBase() as unknown as AiFlowDefinition;
    expect(() =>
      addSellerCallLadder(def, "clever", { dave: DAVE }, { routeStepId: "gone" })
    ).toThrow(/re-read it before patching/);
  });

  it("attempt 1 dials immediately; only the redials carry the quiet-hours window", () => {
    const { def } = patched();
    const calls = collectCalls(parseAiFlowDefinition(def));
    expect(calls.map((c) => c.id)).toEqual(["ai_call_1", "ai_call_2", "ai_call_3"]);
    expect(calls[0].callWindow).toBeUndefined();
    for (const redial of calls.slice(1)) {
      expect(redial.callWindow).toEqual(CALL_WINDOW);
      expect(redial.callWindow?.outside).toBe("skip");
    }
  });

  it("every call: Dave's ref (never a name string), shared outcome var, no captureFields", () => {
    const { def } = patched();
    for (const c of collectCalls(parseAiFlowDefinition(def))) {
      expect(c.toVar).toBe("lead_phone");
      expect(c.saveAs).toBe("call_outcome");
      expect(c.transfer?.toRef).toEqual(DAVE);
      expect(c.notifyRef).toEqual(DAVE);
      expect(c.waitMinutes).toBe(20);
      // Decision 9: a pitch, not an interview. captureFields is what turns
      // one into the other.
      expect(c.captureFields).toBeUndefined();
    }
  });

  it("gates fail the safe way: dial paths on positive equals, stop arms on notEquals", () => {
    const { def } = patched();
    const parsed = parseAiFlowDefinition(def);
    const call1 = parsed.steps.find((s) => s.id === "ai_call_1");
    // A missing price_band reads as "" and the call SKIPS ($1M+ stays human).
    expect(call1?.when).toEqual({ var: "price_band", equals: "under_1m" });
    const followups = parsed.steps.find((s) => s.id === "call_followups");
    expect(followups?.type).toBe("branch");
    if (followups?.type !== "branch") return;
    expect(followups.branches.map((a) => a.condition)).toEqual([
      { var: "call_outcome", equals: "not_placed" },
      { var: "call_outcome", equals: "failed" },
      { var: "call_outcome", equals: "no_answer" }
    ]);
    // transferred / answered / skipped-empty retry nothing.
    expect(followups.else).toEqual([]);
    walk(parsed.steps, (s) => {
      if (s.type !== "branch") return;
      for (const arm of s.branches) {
        if (arm.id.endsWith("_claimed")) {
          // notEquals fails OPEN on a missing var: a broken claimed_agent
          // matches this arm and suppresses the redial, never causes one.
          expect(arm.condition).toEqual({ var: "claimed_agent", notEquals: "none" });
          expect(arm.steps).toEqual([]);
        }
      }
    });
  });

  it("the ladder schedule matches the constants the offer copy is generated from", () => {
    const { def } = patched();
    const parsed = parseAiFlowDefinition(def);
    const sleeps: Array<Extract<Step, { type: "sleep" }>> = [];
    walk(parsed.steps, (s) => {
      if (s.type === "sleep") sleeps.push(s);
    });
    expect(sleeps.map((s) => s.id)).toEqual(["retry_2_sleep", "retry_3_sleep"]);
    expect(sleeps[0].minutes).toBe(ATTEMPT_2_DELAY_MINUTES);
    expect(sleeps[1].untilTime).toBe(ATTEMPT_3_TIME);
    expect(sleeps[1].timezone).toBe(CALL_WINDOW.timezone);
    expect(nextStepsLine()).toContain(`${ATTEMPT_2_DELAY_MINUTES / 60} hours`);
  });

  it("the goal stops on replied and booked, never on claimed, and stays in the trunk", () => {
    const { def } = patched();
    const parsed = parseAiFlowDefinition(def);
    const goal = parsed.steps.find((s) => s.id === "lead_reached");
    expect(goal?.type).toBe("goal");
    if (goal?.type !== "goal") return;
    expect(goal.events).toEqual([{ kind: "replied" }, { kind: "appointment_booked" }]);
    // Nested goals are skipped by the engine's jump machinery, so trunk
    // placement is load-bearing, not stylistic.
    walk(parsed.steps, (s) => {
      if (s.type === "goal") expect(parsed.steps).toContain(s);
    });
  });

  it("rewords the offer with done/result/next, ahead of the reply mechanics", () => {
    const { def } = patched();
    const route = (def.steps as unknown as Record<string, string>[]).find((s) => s.id === "route")!;
    for (const key of ["offerTemplate", "ownerFallbackTemplate"] as const) {
      const t = route[key];
      expect(t).toContain("The AI already: {{vars.actions_taken}}");
      expect(t).toContain("The call: {{vars.call_outcome_label}}");
      expect(t).toContain(nextStepsLine());
      // Mechanics stay last, where a skimming reader looks for them.
      expect(t.indexOf("The AI already:")).toBeLessThan(t.indexOf("Reply 1"));
    }
    expect(route.claimedNotifyTemplate).toContain("The AI has stopped calling this lead.");
    // Applying the reword twice must not stack the block.
    expect(withAiCallLines(route.offerTemplate)).toBe(route.offerTemplate);
  });
});

describe("addSellerCallLadder (ReferralExchange shape)", () => {
  const patched = () => {
    const def = refxBase() as unknown as AiFlowDefinition;
    const changed = addSellerCallLadder(
      def,
      "referral_exchange",
      { dave: DAVE },
      { routeStepId: "route_seller", callGate: { var: "route_lead_type", equals: "seller" } }
    );
    return { def, changed };
  };

  it("wraps attempt 1 in the seller gate and parses", () => {
    const { def, changed } = patched();
    expect(changed).toBe(true);
    const parsed = parseAiFlowDefinition(def);
    expect(parsed.steps.map((s) => s.id)).toEqual([
      "url",
      "read_details",
      "call_gate",
      "route_seller",
      "call_followups",
      "lead_reached",
      "notify"
    ]);
    const gate = parsed.steps.find((s) => s.id === "call_gate");
    expect(gate?.type).toBe("branch");
    if (gate?.type !== "branch") return;
    // Two required conditions, one when slot: the seller check is the arm,
    // the price check rides on the call inside it.
    expect(gate.branches).toHaveLength(1);
    expect(gate.branches[0].condition).toEqual({ var: "route_lead_type", equals: "seller" });
    expect(gate.branches[0].steps.map((s) => s.id)).toEqual(["ai_call_1"]);
    expect(gate.branches[0].steps[0].when).toEqual({ var: "price_band", equals: "under_1m" });
    expect(gate.else).toEqual([]);
  });

  it("the follow-up tree itself is seller-gated, so buyers never enter the ladder", () => {
    const { def } = patched();
    const parsed = parseAiFlowDefinition(def);
    const followups = parsed.steps.find((s) => s.id === "call_followups");
    expect(followups?.when).toEqual({ var: "route_lead_type", equals: "seller" });
  });
});

describe("Amy's approved scripts", () => {
  it("only Clever carries the cash-offer angle", () => {
    expect(PITCH_CLEVER).toContain("cash offer");
    expect(PITCH_CLEVER).toContain("{{vars.cash_offers}}");
    expect(PITCH_REFERRAL_EXCHANGE).not.toContain("cash offer");
    expect(PITCH_REFERRAL_EXCHANGE).toContain("{{vars.web_source}}");
  });

  it("both scripts enforce the never-ask-when-to-call-back rule", () => {
    for (const pitch of [PITCH_CLEVER, PITCH_REFERRAL_EXCHANGE]) {
      expect(pitch).toContain("NEVER ask when a good time to call back would be");
      expect(pitch).toContain("Never ask for their phone number");
      expect(pitch).toContain("winning the listing");
    }
    expect(PITCH_CONTEXT).toContain("NEVER ask for any of it");
  });

  it("no template anywhere contains an em dash", () => {
    for (const text of [
      PITCH_CLEVER,
      PITCH_REFERRAL_EXCHANGE,
      PITCH_CONTEXT,
      nextStepsLine(),
      withAiCallLines("x\nReply 1 now")
    ]) {
      expect(text.includes("\u2014")).toBe(false);
    }
  });
});

describe("addCashOffersField", () => {
  it("appends the spoke-check's verbatim field once", () => {
    const def = cleverBase() as unknown as AiFlowDefinition;
    expect(addCashOffersField(def)).toBe(true);
    const read = (def.steps as Record<string, unknown>[])[1] as {
      fields: { name: string; description: string }[];
    };
    const field = read.fields.find((f) => f.name === "cash_offers");
    // Verbatim from the live spoke-check flow: identical wording means
    // identical extraction behavior on the same page.
    expect(field?.description).toBe(CASH_OFFERS_FIELD.description);
    expect(addCashOffersField(def)).toBe(false);
  });

  it("refuses a flow with no read_details step", () => {
    const def = { version: 1, trigger: { channel: "manual" }, steps: [] } as unknown as AiFlowDefinition;
    expect(() => addCashOffersField(def)).toThrow(/read_details step not found/);
  });
});

describe("removeBestTimeCaptureField", () => {
  it("sweeps the field wherever it nests, and drops an emptied captureFields", () => {
    const def = {
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "b",
          type: "branch",
          question: "call?",
          branches: [
            {
              id: "yes",
              label: "yes",
              condition: { var: "x", equals: "y" },
              steps: [
                {
                  id: "call1",
                  type: "place_ai_call",
                  toVar: "p",
                  personaTemplate: "hi",
                  captureFields: ["their timeline", BEST_TIME_CAPTURE_FIELD]
                },
                {
                  id: "call2",
                  type: "place_ai_call",
                  toVar: "p",
                  personaTemplate: "hi",
                  captureFields: [BEST_TIME_CAPTURE_FIELD]
                }
              ]
            }
          ],
          else: []
        }
      ]
    } as unknown as AiFlowDefinition;
    expect(removeBestTimeCaptureField(def)).toBe(true);
    const arm = (def.steps[0] as { branches: { steps: Record<string, unknown>[] }[] })
      .branches[0];
    expect(arm.steps[0].captureFields).toEqual(["their timeline"]);
    // captureFields has min(1): the emptied one must vanish, not linger.
    expect("captureFields" in arm.steps[1]).toBe(false);
    expect(removeBestTimeCaptureField(def)).toBe(false);
  });
});
