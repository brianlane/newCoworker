import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  OWNER_LINE_NEW,
  OWNER_LINE_OLD,
  PRICE_GATE_FIELD_PORTAL,
  PRICE_GATE_FIELD_TYPED,
  PRICE_GATE_VAR,
  findStepDeep,
  patchClever,
  patchNewLeadIntake,
  patchRealtor,
  patchReferralExchange,
  promoteRouteFromSource,
  type Definition
} from "../scripts/oneshot/amy-under-500k-ai-owned";
import { AUTO_TAG_NOTE } from "../scripts/oneshot/amy-needs-follow-up-definition";

/**
 * Fixtures mirror the LIVE flows' relevant structure (step ids, whens, the
 * fields the patchers touch), compact enough to read but complete enough that
 * parseAiFlowDefinition accepts the PATCHED result: the applier refuses to
 * write an invalid definition, so a fixture that cannot validate would let a
 * structural bug hide until apply time.
 */

type Step = Record<string, unknown>;

const OWNER_LINE = `${OWNER_LINE_OLD} {{vars.claimed_agent}}`;

function routeStep(id: string, extra: Step = {}): Step {
  return {
    id,
    type: "route_to_team",
    offerTemplate: "New lead: {{vars.lead_name}} ({{vars.lead_phone}})",
    ownerFallbackTemplate: "Nobody claimed {{vars.lead_name}}. It's back to you.",
    responseMinutes: 10,
    claimedNotifyEmail: "amy@amylaidlaw.com",
    ownerDirectWhen: { var: "price_band", equals: "over_1m" },
    ownerDirectTemplate: "HIGH-VALUE {{vars.lead_name}}",
    ...extra
  };
}

function cleverFixture(): Definition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "Clever referral" }] },
    steps: [
      {
        id: "read_details",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "lead_email" },
          { name: "lead_address" },
          { name: "price" },
          { name: "price_band" }
        ]
      },
      {
        id: "ai_call_1",
        type: "place_ai_call",
        toVar: "lead_phone",
        personaTemplate: "Hi {{vars.lead_name}}, is now a good time?",
        notifyOwner: true,
        saveAs: "call_outcome",
        when: { var: "price_band", equals: "under_1m" }
      },
      routeStep("route", { agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"] }),
      { id: "lead_reached", type: "goal", label: "Replied or booked", events: [{ kind: "replied" }] },
      {
        id: "qt_email",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}} QT, Clever",
        body: `Details for {{vars.lead_name}}\n${OWNER_LINE}`
      }
    ]
  };
}

function realtorFixture(): Definition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "rltr.pro" }] },
    steps: [
      {
        id: "s1",
        type: "extract_text",
        fields: [{ name: "lead_name" }, { name: "lead_phone" }, { name: "price_band" }]
      },
      { id: "s3", type: "send_sms", to: "{{vars.lead_phone}}", body: "Hi {{vars.lead_name}}" },
      routeStep("s4", { agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"] }),
      {
        id: "s2",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}}, Realtor.com",
        body: `Details\n${OWNER_LINE}`
      }
    ]
  };
}

function nliFixture(): Definition {
  return {
    version: 1,
    trigger: { channel: "manual" },
    steps: [
      {
        id: "parse",
        type: "extract_text",
        fields: [
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "price_band" },
          { name: "call_gate" },
          { name: "route_variant" },
          { name: "assigned_agent" }
        ]
      },
      {
        id: "call_branch",
        type: "branch",
        question: "Did the message ask for this lead to be called?",
        branches: [
          {
            id: "call_yes",
            label: "Yes: call them",
            condition: { var: "call_gate", equals: "yes" },
            steps: [
              {
                id: "call_lead_en",
                type: "place_ai_call",
                toVar: "lead_phone",
                personaTemplate: "Hi {{vars.lead_name}}",
                notifyOwner: true,
                saveAs: "call_outcome"
              }
            ]
          }
        ],
        else: []
      },
      routeStep("route_assigned", {
        agentNameVar: "assigned_agent",
        when: { var: "route_variant", equals: "assigned" }
      }),
      routeStep("route_buyer", { when: { var: "route_variant", equals: "buyer" } }),
      routeStep("route_seller", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_variant", equals: "seller" }
      }),
      routeStep("route_both", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_variant", equals: "both" }
      })
    ]
  };
}

function reFixture(): Definition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "ReferralExchange" }] },
    steps: [
      {
        id: "browse",
        type: "extract_text",
        fields: [
          { name: "lead_type" },
          { name: "lead_name" },
          { name: "lead_phone" },
          { name: "lead_email" },
          { name: "location" },
          { name: "price" },
          { name: "price_band" },
          { name: "route_lead_type" }
        ]
      },
      {
        id: "ai_first_contact",
        type: "branch",
        question: "Which script should the AI open with?",
        branches: [
          {
            id: "ai_call_seller_arm",
            label: "Seller script",
            condition: { var: "route_lead_type", equals: "seller" },
            steps: [
              {
                id: "ai_call_seller",
                type: "place_ai_call",
                toVar: "lead_phone",
                personaTemplate: "Hi {{vars.lead_name}}",
                notifyOwner: true,
                saveAs: "call_outcome",
                when: { var: "price_band", equals: "under_1m" }
              }
            ]
          }
        ],
        else: []
      },
      {
        id: "ai_no_answer_followup",
        type: "update_contact",
        phoneVar: "lead_phone",
        addTags: ["Needs Follow Up"],
        when: { var: "call_outcome", equals: "no_answer" }
      },
      routeStep("route_buyer", { when: { var: "route_lead_type", equals: "buyer" } }),
      routeStep("route_seller", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_lead_type", equals: "seller" }
      }),
      routeStep("route_both", {
        agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
        when: { var: "route_lead_type", equals: "both" }
      }),
      {
        id: "email_seller",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}} QT RE",
        body: `Details\n${OWNER_LINE}`,
        when: { var: "lead_type", equals: "seller" }
      },
      {
        id: "email_buyer",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}} BS RE",
        body: `Details\n${OWNER_LINE}`,
        when: { var: "lead_type", equals: "buyer" }
      },
      {
        id: "email_both",
        type: "send_email",
        to: "amy@amylaidlaw.com",
        subject: "{{vars.lead_name}} BS QT RE",
        body: `Details\n${OWNER_LINE}`,
        when: { var: "lead_type", equals: "both" }
      }
    ]
  };
}

function validate(def: Definition): void {
  const parsed = parseAiFlowDefinition(def);
  expect(validateDefinitionSemantics(parsed)).toEqual([]);
}

describe("fail-safe direction of every guard", () => {
  it("routes gate on notEquals ai, so a missing extraction keeps today's routing", () => {
    for (const [fixture, patch, routeId] of [
      [cleverFixture(), patchClever, "route"],
      [realtorFixture(), patchRealtor, "s4"]
    ] as const) {
      const def = fixture;
      patch(def);
      expect(findStepDeep(def.steps, routeId)?.when).toEqual({
        var: PRICE_GATE_VAR,
        notEquals: "ai"
      });
    }
  });

  it("gated extras gate on equals ai, so a missing extraction adds nothing", () => {
    const clever = cleverFixture();
    patchClever(clever);
    expect(findStepDeep(clever.steps, "clever_gated_after_call")?.when).toEqual({
      var: PRICE_GATE_VAR,
      equals: "ai"
    });
    const realtor = realtorFixture();
    patchRealtor(realtor);
    expect(findStepDeep(realtor.steps, "rt_gated_tag")?.when).toEqual({
      var: PRICE_GATE_VAR,
      equals: "ai"
    });
  });

  it("refuses to overwrite an unexpected when on a route step", () => {
    const def = cleverFixture();
    const route = findStepDeep(def.steps, "route")!;
    route.when = { var: "something_else", equals: "x" };
    expect(() => patchClever(def)).toThrow(/already has a when guard/);
  });
});

describe("Clever", () => {
  it("adds the portal price_gate field, gated branch after the goal, and validates", () => {
    const def = cleverFixture();
    const { changed, notes } = patchClever(def);
    expect(changed).toBe(true);
    expect(notes.join(" ")).toContain("price_gate");
    const fields = findStepDeep(def.steps, "read_details")!.fields as Array<{ name: string }>;
    expect(fields.map((f) => f.name)).toContain(PRICE_GATE_VAR);
    // AFTER the goal: steps after a goal run on both paths, so a reply's
    // goal-jump out of the retry ladder still passes through the gate.
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids.indexOf("clever_gated_after_call")).toBe(ids.indexOf("lead_reached") + 1);
    validate(def);
  });

  it("promotes a live transfer and hands everything else to the cadence", () => {
    const def = cleverFixture();
    patchClever(def);
    const branch = findStepDeep(def.steps, "clever_gated_after_call") as {
      branches: Array<{ id: string; condition: unknown; steps: Step[] }>;
      else: Step[];
    };
    const [transferred, noAnswer, answered] = branch.branches;
    expect(transferred.condition).toEqual({ var: "call_outcome", equals: "transferred" });
    expect(transferred.steps[0]).toMatchObject({
      id: "clever_route_promote",
      type: "route_to_team",
      claimedNotifyEmail: "amy@amylaidlaw.com"
    });
    // A call that reached a machine or a person hands over with the auto
    // note (no immediate cadence call); a call that never went out tags
    // plain, so the cadence's immediate call IS the first contact.
    expect(noAnswer.steps[0]).toMatchObject({ noteTemplate: AUTO_TAG_NOTE });
    expect(answered.steps[0]).toMatchObject({ noteTemplate: AUTO_TAG_NOTE });
    expect(branch.else[0]).toMatchObject({ type: "update_contact" });
    expect((branch.else[0] as { noteTemplate?: string }).noteTemplate).toBeUndefined();
  });

  it("is idempotent", () => {
    const def = cleverFixture();
    patchClever(def);
    const after = JSON.parse(JSON.stringify(def));
    expect(patchClever(def).changed).toBe(false);
    expect(def).toEqual(after);
  });
});

describe("promoteRouteFromSource", () => {
  it("keeps the claim wiring, drops when and the unreachable owner-direct config", () => {
    const source = routeStep("route_seller", {
      agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
      when: { var: "route_lead_type", equals: "seller" }
    });
    const promote = promoteRouteFromSource(source, "re_route_promote", "READY: {{vars.lead_name}}");
    expect(promote).toMatchObject({
      id: "re_route_promote",
      agentNames: ["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"],
      claimedNotifyEmail: "amy@amylaidlaw.com",
      offerTemplate: "READY: {{vars.lead_name}}"
    });
    expect(promote.when).toBeUndefined();
    expect(promote.ownerDirectWhen).toBeUndefined();
    expect(promote.ownerDirectTemplate).toBeUndefined();
    // The source is untouched: the clone must not strip the live route.
    expect(source.ownerDirectWhen).toBeDefined();
    expect(source.when).toBeDefined();
  });
});

describe("Realtor.com", () => {
  it("gates s4, tags gated sellers plain (the cadence makes the first call), validates", () => {
    const def = realtorFixture();
    const { changed } = patchRealtor(def);
    expect(changed).toBe(true);
    const fields = findStepDeep(def.steps, "s1")!.fields as Array<{ name: string; description: string }>;
    expect(fields.find((f) => f.name === PRICE_GATE_VAR)?.description).toBe(
      PRICE_GATE_FIELD_TYPED.description
    );
    const tag = findStepDeep(def.steps, "rt_gated_tag")!;
    expect(tag).toMatchObject({ type: "update_contact", addTags: ["Needs Follow Up"] });
    expect((tag as { noteTemplate?: string }).noteTemplate).toBeUndefined();
    validate(def);
    expect(patchRealtor(def).changed).toBe(false);
  });
});

describe("New Lead Intake", () => {
  it("wraps seller/both routes; buyers and assigned stay top-level and untouched", () => {
    const def = nliFixture();
    const { changed } = patchNewLeadIntake(def);
    expect(changed).toBe(true);
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids).toContain("route_buyer");
    expect(ids).toContain("route_assigned");
    expect(ids).toContain("nli_seller_gate");
    expect(ids).not.toContain("route_seller");
    const gate = findStepDeep(def.steps, "nli_seller_gate") as {
      branches: Array<{ condition: unknown }>;
      else: Step[];
    };
    expect(gate.branches[0].condition).toEqual({ var: PRICE_GATE_VAR, equals: "ai" });
    // Originals live in the else with their own route_variant guards intact.
    expect(gate.else.map((s) => s.id)).toEqual(["route_seller", "route_both"]);
    expect((gate.else[0] as { when?: unknown }).when).toEqual({
      var: "route_variant",
      equals: "seller"
    });
    validate(def);
    expect(patchNewLeadIntake(def).changed).toBe(false);
  });

  it("keys the cadence note on whether a call just happened, per lead type", () => {
    const def = nliFixture();
    patchNewLeadIntake(def);
    const na = findStepDeep(def.steps, "nli_g_tag_na_s")!;
    expect(na).toMatchObject({
      noteTemplate: AUTO_TAG_NOTE,
      when: { var: "route_variant", equals: "seller" }
    });
    const plain = findStepDeep(def.steps, "nli_g_tag_s")!;
    expect((plain as { noteTemplate?: string }).noteTemplate).toBeUndefined();
    expect(plain.when).toEqual({ var: "route_variant", equals: "seller" });
  });
});

describe("ReferralExchange", () => {
  it("wraps seller/both routes, patches the live auto note, promotes transfers, validates", () => {
    const def = reFixture();
    const { changed, notes } = patchReferralExchange(def);
    expect(changed).toBe(true);
    expect(notes.join(" ")).toContain("AUTO_TAG_NOTE");
    expect(findStepDeep(def.steps, "ai_no_answer_followup")).toMatchObject({
      noteTemplate: AUTO_TAG_NOTE
    });
    const gate = findStepDeep(def.steps, "re_seller_gate") as { else: Step[] };
    expect(gate.else.map((s) => s.id)).toEqual(["route_seller", "route_both"]);
    const after = findStepDeep(def.steps, "re_gated_after_call") as {
      branches: Array<{ id: string; steps: Step[] }>;
    };
    // no_answer is already tagged by the flow's own top-level step, so the
    // arm is deliberately empty: a second tag would just churn the contact.
    const noAnswerArm = after.branches.find((b) => b.id === "re_g_no_answer")!;
    expect(noAnswerArm.steps).toEqual([]);
    expect(after.branches.find((b) => b.id === "re_g_transferred")!.steps[0]).toMatchObject({
      id: "re_route_promote"
    });
    validate(def);
    expect(patchReferralExchange(def).changed).toBe(false);
  });

  it("rewords the owner line in all three Amy emails", () => {
    const def = reFixture();
    patchReferralExchange(def);
    for (const id of ["email_buyer", "email_seller", "email_both"]) {
      expect(String(findStepDeep(def.steps, id)!.body)).toContain(OWNER_LINE_NEW);
    }
  });
});

describe("the two extraction scopes", () => {
  it("the portal field asks only about price; the typed field excludes buyers", () => {
    expect(PRICE_GATE_FIELD_PORTAL.description).not.toMatch(/buyer/i);
    expect(PRICE_GATE_FIELD_TYPED.description).toMatch(/every pure buyer lead/);
    for (const f of [PRICE_GATE_FIELD_PORTAL, PRICE_GATE_FIELD_TYPED]) {
      expect(f.description.length).toBeLessThanOrEqual(300);
      expect(f.description).toContain("$500,000");
    }
  });
});
