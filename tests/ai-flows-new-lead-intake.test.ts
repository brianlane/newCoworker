import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  buildDefinition,
  DEFAULT_FLOW_NAME,
  REFERRAL_TOUCH_LINE,
  REFERRAL_TOUCH_LINE_ES
} from "../scripts/oneshot/seed-amy-new-lead-intake";

/**
 * The "New Lead Intake" seed for Amy: she texts (or calls, or types to) her
 * coworker a lead's details in plain words and the flow takes it from there.
 * Pins the contracts its correctness rides on:
 *
 *   - the definition parses through the REAL parseAiFlowDefinition, inside the
 *     extract step's 15-field cap;
 *   - manual trigger channel (never auto-starts);
 *   - the contact upsert stamps the language it was told, and is gated on a
 *     parsed phone (upsert_customer fails hard on an unusable phoneVar);
 *   - the referral touch and the Spanish intro are both equals-gated, so a
 *     missed extraction fails CLOSED into the standard English copy and no
 *     sentinel or empty name can ever reach a lead;
 *   - "call this lead" places the call in the lead's language and suppresses
 *     the intro TEXT, but never the team routing;
 *   - the $1M+ keep-for-owner rule survives on every lead-type route, while an
 *     explicitly named teammate overrides it;
 *   - a phoneless lead reaches only the intro email and the honest notify.
 */

type Step = Record<string, unknown> & {
  id: string;
  type: string;
  when?: { var: string; equals?: string; notEquals?: string };
};

type BranchStep = Step & {
  branches?: { id: string; condition: Record<string, unknown>; steps: Step[] }[];
  else?: Step[];
};

function topSteps(def: unknown): Step[] {
  return (def as { steps: Step[] }).steps;
}

/** Every step, including branch-arm and else-arm nesting. */
function allSteps(def: unknown): Step[] {
  const out: Step[] = [];
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      out.push(s);
      const b = s as BranchStep;
      for (const arm of b.branches ?? []) walk(arm.steps);
      if (b.else) walk(b.else);
    }
  };
  walk(topSteps(def));
  return out;
}

function step(def: unknown, id: string): Step {
  const found = allSteps(def).find((s) => s.id === id);
  if (!found) throw new Error(`step "${id}" missing`);
  return found;
}

const LEAD_TYPES = ["buyer", "seller", "both"] as const;

describe("seed-amy-new-lead-intake definition", () => {
  it("parses through the real parseAiFlowDefinition", () => {
    expect(() => parseAiFlowDefinition(buildDefinition())).not.toThrow();
  });

  it("is manual-channel (run on demand only) under the expected name", () => {
    const def = buildDefinition() as { trigger: { channel: string } };
    expect(def.trigger).toEqual({ channel: "manual" });
    expect(DEFAULT_FLOW_NAME).toBe("New Lead Intake");
  });

  it("extracts the exact gate vars the steps rely on, within the 15-field cap", () => {
    const parse = step(buildDefinition(), "parse") as Step & {
      fields: { name: string; description: string }[];
    };
    const names = parse.fields.map((f) => f.name);
    for (const required of [
      "lead_name",
      "lead_phone",
      "lead_email",
      "lead_type",
      "lead_details",
      "price",
      "price_band",
      "lead_language",
      "phone_lead_type",
      "email_intro_type",
      "call_gate",
      "referred_by",
      "referral_gate",
      "assigned_agent",
      "route_variant"
    ]) {
      expect(names).toContain(required);
    }
    // The schema caps extract_text at 15 fields; this flow sits exactly at it,
    // so a new field has to replace one rather than be bolted on.
    expect(parse.fields.length).toBeLessThanOrEqual(15);
    // Every gate a step reads must be produced here.
    const gates = new Set(
      allSteps(buildDefinition())
        .map((s) => s.when?.var)
        .filter((v): v is string => Boolean(v))
    );
    for (const gate of gates) expect(names).toContain(gate);
  });

  it("the contact upsert stamps the language and is gated on a parsed phone", () => {
    const save = step(buildDefinition(), "save_contact");
    expect(save.type).toBe("upsert_customer");
    // route_variant answers "none" exactly when there is no phone.
    expect(save.when).toEqual({ var: "route_variant", notEquals: "none" });
    expect(save.phoneVar).toBe("lead_phone");
    expect(save.nameVar).toBe("lead_name");
    expect(save.emailVar).toBe("lead_email");
    // The language Amy mentioned is stored, so LATER surfaces speak it too.
    expect(save.languageVar).toBe("lead_language");
  });

  it("forks the intro on an equals-matched referral gate (fails closed)", () => {
    const intro = step(buildDefinition(), "intro") as BranchStep;
    expect(intro.type).toBe("branch");
    expect(intro.branches).toHaveLength(1);
    // equals (not notEquals): a missing/failed referral extraction resolves to
    // "" which never equals "referral", so the standard arm runs.
    expect(intro.branches?.[0].condition).toEqual({
      var: "referral_gate",
      equals: "referral"
    });
  });

  it("forks each referral arm again on language, equals-gated on es", () => {
    const def = buildDefinition();
    for (const id of ["intro_lang", "intro_lang_ref"]) {
      const langBranch = step(def, id) as BranchStep;
      expect(langBranch.type).toBe("branch");
      expect(langBranch.branches?.[0].condition).toEqual({
        var: "lead_language",
        equals: "es"
      });
      // English arm keeps a variant per lead type; Spanish arm is one body.
      expect(langBranch.else).toHaveLength(6);
      expect(langBranch.branches?.[0].steps).toHaveLength(2);
    }
  });

  it("English intro variants gate on the exact lead-type tokens with quiet hours", () => {
    const def = buildDefinition();
    for (const suffix of ["", "_ref"]) {
      for (const type of LEAD_TYPES) {
        const send = step(def, `send_${type}${suffix}`) as Step & {
          quietHours?: { noSendAfter?: string; emailFallbackVar?: string };
        };
        expect(send.type).toBe("send_sms");
        expect(send.to).toBe("{{vars.lead_phone}}");
        expect(send.when).toEqual({ var: "phone_lead_type", equals: type });
        expect(send.quietHours?.noSendAfter).toBe("22:00");
        expect(send.quietHours?.emailFallbackVar).toBe("lead_email");

        const email = step(def, `email_lead_${type}${suffix}`);
        expect(email.type).toBe("send_email");
        expect(email.when).toEqual({ var: "email_intro_type", equals: type });
        expect(email.fromConnectionId).toBeTruthy();
      }
    }
  });

  it("the Spanish intro reuses the channel tokens, so language and channel stay independent", () => {
    const def = buildDefinition();
    for (const suffix of ["", "_ref"]) {
      const sms = step(def, `send_es${suffix}`);
      expect(sms.type).toBe("send_sms");
      expect(sms.when).toEqual({ var: "phone_lead_type", notEquals: "none" });
      const email = step(def, `email_lead_es${suffix}`);
      expect(email.type).toBe("send_email");
      expect(email.when).toEqual({ var: "email_intro_type", notEquals: "none" });
      // Spanish copy, in Spanish, with her real phone number.
      expect(String(sms.body)).toContain("Amy Laidlaw");
      expect(String(sms.body)).toContain("602-695-1142");
      expect(String(sms.body)).toContain("Hola");
    }
  });

  it("the referral credit appears in each language's own words, only on the referral arm", () => {
    const def = buildDefinition();
    expect(REFERRAL_TOUCH_LINE).toContain("{{vars.referred_by}}");
    expect(REFERRAL_TOUCH_LINE_ES).toContain("{{vars.referred_by}}");
    expect(String(step(def, "send_buyer_ref").body)).toContain(REFERRAL_TOUCH_LINE);
    expect(String(step(def, "send_es_ref").body)).toContain(REFERRAL_TOUCH_LINE_ES);
    // The standard arms never mention a referrer.
    for (const id of ["send_buyer", "send_seller", "send_both", "send_es"]) {
      expect(String(step(def, id).body)).not.toContain("{{vars.referred_by}}");
    }
  });

  it("'call this lead' places the call in the lead's language, summary to the owner", () => {
    const def = buildDefinition();
    const branch = step(def, "call_branch") as BranchStep;
    expect(branch.branches?.[0].condition).toEqual({ var: "call_gate", equals: "yes" });
    // No call asked for: the else arm is empty, so nothing happens.
    expect(branch.else).toEqual([]);
    const es = step(def, "call_lead_es");
    const en = step(def, "call_lead_en");
    for (const call of [es, en]) {
      expect(call.type).toBe("place_ai_call");
      expect(call.toVar).toBe("lead_phone");
      // notifyOwner keeps her cell out of the definition (it follows Settings).
      expect(call.notifyOwner).toBe(true);
      expect(call.notifyE164).toBeUndefined();
      expect(call.saveAs).toBe("call_outcome");
      // No live transfer: the AI calls and does what it normally does.
      expect(call.transfer).toBeUndefined();
      expect(String(call.contextTemplate)).toContain("{{vars.lead_details}}");
    }
    expect(es.when).toEqual({ var: "lead_language", equals: "es" });
    expect(en.when).toEqual({ var: "lead_language", equals: "none" });
    expect(String(es.personaTemplate)).toContain("Hola");
    expect(String(en.personaTemplate)).toContain("Amy Laidlaw's office");
  });

  it("a call request suppresses the intro TEXT but never the routing", () => {
    const parse = step(buildDefinition(), "parse") as Step & {
      fields: { name: string; description: string }[];
    };
    // phone_lead_type is what the intro texts gate on, so it must answer none
    // for a call-only request.
    const phoneType = parse.fields.find((f) => f.name === "phone_lead_type");
    expect(phoneType?.description).toContain("only");
    expect(phoneType?.description).toContain("call");
    // route_variant carries no call notion at all: routing happens either way.
    const routeVariant = parse.fields.find((f) => f.name === "route_variant");
    expect(routeVariant?.description).not.toContain("call");
  });

  it("default routes gate on route_variant lead types; buyer un-pinned, seller/both pin the agent", () => {
    const def = buildDefinition({ agentName: "Dave Lane" });
    for (const type of LEAD_TYPES) {
      const route = step(def, `route_${type}`);
      expect(route.type).toBe("route_to_team");
      expect(route.when).toEqual({ var: "route_variant", equals: type });
      if (type === "buyer") {
        expect(route.agentName).toBeUndefined();
        expect(route.agentNames).toBeUndefined();
      } else {
        expect(route.agentName).toBe("Dave Lane");
      }
      // The $1M+ rule stays on the lead-type routes.
      expect(route.ownerDirectWhen).toEqual({ var: "price_band", equals: "over_1m" });
      expect(route.ownerDirectNudges).toBe(true);
    }
  });

  it("an explicitly named teammate rides the DYNAMIC pin and overrides the $1M rule", () => {
    const route = step(buildDefinition(), "route_assigned");
    expect(route.type).toBe("route_to_team");
    expect(route.when).toEqual({ var: "route_variant", equals: "assigned" });
    expect(route.agentNameVar).toBe("assigned_agent");
    expect(route.agentName).toBeUndefined();
    // Amy naming a person IS the decision: no keep-for-owner override.
    expect(route.ownerDirectWhen).toBeUndefined();
    expect(route.ownerDirectTemplate).toBeUndefined();
    expect(String(route.offerTemplate)).toContain("Amy asked for this lead to go to YOU");
    expect(String(route.ownerFallbackTemplate)).toContain("{{vars.assigned_agent}}");
  });

  it("a phoneless lead reaches only the intro email and the honest notify", () => {
    const def = buildDefinition();
    // route_variant = "none" closes the upsert, every route, and the main notify.
    const phoneGated = allSteps(def).filter(
      (s) => s.when?.var === "route_variant" && s.when.notEquals === "none"
    );
    expect(phoneGated.map((s) => s.id).sort()).toEqual(["notify", "save_contact"]);
    const routeGated = allSteps(def).filter(
      (s) => s.when?.var === "route_variant" && s.when.equals !== undefined
    );
    expect(routeGated).toHaveLength(5); // assigned + 3 lead types + notify_no_phone
    const noPhone = step(def, "notify_no_phone");
    expect(noPhone.when).toEqual({ var: "route_variant", equals: "none" });
    expect(String(noPhone.message)).toContain("NO usable phone number");
  });

  it("the owner notify reports the call outcome, so a failed call is never 'handled'", () => {
    const notify = step(buildDefinition(), "notify");
    expect(String(notify.message)).toContain("{{vars.call_outcome}}");
    expect(String(notify.message)).toContain("{{vars.actions_taken}}");
  });

  it("honors an overridden agent and mailbox across every intro arm", () => {
    const def = buildDefinition({
      agentName: "Gabrielle Mota",
      mailboxConnectionId: "11111111-2222-4333-8444-555555555555"
    });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(step(def, "route_seller").agentName).toBe("Gabrielle Mota");
    for (const id of ["email_lead_buyer", "email_lead_buyer_ref", "email_lead_es"]) {
      expect(step(def, id).fromConnectionId).toBe("11111111-2222-4333-8444-555555555555");
    }
    for (const id of ["send_buyer", "send_buyer_ref", "send_es"]) {
      const send = step(def, id) as Step & {
        quietHours?: { emailFromConnectionId?: string };
      };
      expect(send.quietHours?.emailFromConnectionId).toBe(
        "11111111-2222-4333-8444-555555555555"
      );
    }
  });
});
