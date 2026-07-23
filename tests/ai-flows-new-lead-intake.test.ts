import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  buildDefinition,
  DEFAULT_FLOW_NAME,
  DEFAULT_PINNABLE_TEAMMATES,
  REFERRAL_TOUCH_LINE
} from "../scripts/oneshot/seed-amy-new-lead-intake";

/**
 * The "New Lead Intake" seed for Amy (owner-handed leads texted to her
 * coworker line, run via the operator's run_aiflow with her raw message as
 * the trigger window text). Pins the contracts the flow's correctness rides
 * on:
 *
 *   - the definition parses through the REAL parseAiFlowDefinition;
 *   - manual trigger channel (never auto-starts);
 *   - buyer/seller/both gating uses the exact lowercase tokens the
 *     extract_text fields promise;
 *   - the contact upsert and every lead-facing step are gated on a parsed
 *     phone (upsert_customer fails hard on an unusable phoneVar), and the
 *     no-phone path reaches ONLY the intro-email + no-phone-notify steps;
 *   - the referral personal touch ("it's a referral from Donald") forks the
 *     intro on an equals-matched gate, so a missed extraction fails CLOSED
 *     into the standard copy and no sentinel/empty name can reach the lead;
 *   - the $1M+ keep-for-owner rule is present on every route variant;
 *   - quiet hours guard every lead-facing SMS;
 *   - buyer route is un-pinned (roster cascade), seller/both pin Dave.
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

  it("extracts the exact gate vars the steps rely on", () => {
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
      "location",
      "price",
      "price_band",
      "phone_lead_type",
      "email_intro_type",
      "referred_by",
      "referral_gate",
      "route_variant"
    ]) {
      expect(names).toContain(required);
    }
    // The referral fact rides lead_details into the team offer / notify.
    const details = parse.fields.find((f) => f.name === "lead_details");
    expect(details?.description).toContain("who referred them");
    // The routing token teaches the model every pinnable teammate AND the
    // lead-type fallback, and answers none without a phone.
    const variant = parse.fields.find((f) => f.name === "route_variant");
    for (const t of DEFAULT_PINNABLE_TEAMMATES) {
      expect(variant?.description).toContain(t.token);
    }
    expect(variant?.description).toContain("buyer, seller, or both");
    expect(variant?.description).toContain("answer exactly: none");
  });

  it("gates the contact upsert on a parsed phone (upsert fails hard on 'none')", () => {
    const save = step(buildDefinition(), "save_contact");
    expect(save.type).toBe("upsert_customer");
    expect(save.when).toEqual({ var: "phone_lead_type", notEquals: "none" });
    expect(save.phoneVar).toBe("lead_phone");
    expect(save.nameVar).toBe("lead_name");
    expect(save.emailVar).toBe("lead_email");
  });

  it("forks the intro on an equals-matched referral gate (fails closed)", () => {
    const intro = step(buildDefinition(), "intro") as BranchStep;
    expect(intro.type).toBe("branch");
    expect(intro.branches).toHaveLength(1);
    // equals (not notEquals): a missing/failed referral extraction resolves
    // to "" which never equals "referral", so the standard arm runs.
    expect(intro.branches?.[0].condition).toEqual({
      var: "referral_gate",
      equals: "referral"
    });
  });

  it("both intro arms carry the 3 SMS + 3 email variants with the same gates and quiet hours", () => {
    const def = buildDefinition();
    const intro = step(def, "intro") as BranchStep;
    for (const [arm, suffix] of [
      [intro.branches![0].steps, "_ref"],
      [intro.else!, ""]
    ] as const) {
      for (const type of LEAD_TYPES) {
        const send = arm.find((s) => s.id === `send_${type}${suffix}`) as
          | (Step & { quietHours?: { noSendAfter?: string; emailFallbackVar?: string } })
          | undefined;
        expect(send, `send_${type}${suffix}`).toBeTruthy();
        expect(send!.type).toBe("send_sms");
        expect(send!.to).toBe("{{vars.lead_phone}}");
        expect(send!.when).toEqual({ var: "phone_lead_type", equals: type });
        expect(send!.quietHours?.noSendAfter).toBe("22:00");
        expect(send!.quietHours?.emailFallbackVar).toBe("lead_email");

        const email = arm.find((s) => s.id === `email_lead_${type}${suffix}`);
        expect(email, `email_lead_${type}${suffix}`).toBeTruthy();
        expect(email!.type).toBe("send_email");
        expect(email!.to).toBe("{{vars.lead_email}}");
        expect(email!.when).toEqual({ var: "email_intro_type", equals: type });
        expect(email!.fromConnectionId).toBeTruthy();
      }
    }
  });

  it("referral-arm copy opens with the personal touch; standard arm never mentions the referrer", () => {
    const intro = step(buildDefinition(), "intro") as BranchStep;
    expect(REFERRAL_TOUCH_LINE).toContain("{{vars.referred_by}}");
    for (const s of intro.branches![0].steps) {
      const body = String(s.body);
      expect(body, s.id).toContain(REFERRAL_TOUCH_LINE);
      // Inserted right after the greeting, before the pitch.
      expect(body.indexOf("Hi {{vars.lead_name}}.")).toBeLessThan(
        body.indexOf(REFERRAL_TOUCH_LINE)
      );
    }
    for (const s of intro.else!) {
      expect(String(s.body), s.id).not.toContain("{{vars.referred_by}}");
    }
  });

  it("default routes gate on the route_variant lead-type tokens; buyer un-pinned, seller/both pin the agent", () => {
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
    }
  });

  it("an explicitly named teammate gets a pinned route (no $1M override, honest fallback)", () => {
    const def = buildDefinition();
    for (const t of DEFAULT_PINNABLE_TEAMMATES) {
      const route = step(def, `route_pin_${t.token}`);
      expect(route.type).toBe("route_to_team");
      // Exactly one route can fire: the same token gates pin vs lead type.
      expect(route.when).toEqual({ var: "route_variant", equals: t.token });
      // Literal roster name: agentName is never template-rendered.
      expect(route.agentName).toBe(t.name);
      expect(String(route.agentName)).not.toContain("{{");
      // Amy naming a person IS the decision: no keep-for-owner override.
      expect(route.ownerDirectWhen).toBeUndefined();
      expect(route.ownerDirectTemplate).toBeUndefined();
      // The teammate is told this was a personal hand-off.
      expect(String(route.offerTemplate)).toContain("Amy asked for this lead to go to YOU");
      // Fallback names the broken promise, back to Amy, never someone else.
      expect(String(route.ownerFallbackTemplate)).toContain(t.name);
      expect(String(route.ownerFallbackTemplate)).toContain("you asked for them to take it");
    }
    // Roster names must match Amy's live ai_flow_team_members rows exactly.
    expect(DEFAULT_PINNABLE_TEAMMATES.map((t) => t.name)).toEqual([
      "Dave Lane",
      "Gabrielle Mota",
      "Jason Lane"
    ]);
  });

  it("keeps $1M+ leads for Amy on every route variant", () => {
    const def = buildDefinition();
    for (const type of LEAD_TYPES) {
      const route = step(def, `route_${type}`);
      expect(route.ownerDirectWhen).toEqual({ var: "price_band", equals: "over_1m" });
      expect(route.ownerDirectTemplate).toContain("kept for you");
      expect(route.ownerDirectNudges).toBe(true);
    }
  });

  it("the no-phone path reaches only intro-email + the honest no-phone notify", () => {
    const def = buildDefinition();
    // With phone_lead_type = "none", every phone-gated step skips…
    const phoneGated = topSteps(def).filter(
      (s) => s.when?.var === "phone_lead_type" && s.when.notEquals === "none"
    );
    expect(phoneGated.map((s) => s.id)).toEqual(["save_contact", "notify"]);
    const typeGated = allSteps(def).filter(
      (s) =>
        s.when?.var === "phone_lead_type" &&
        LEAD_TYPES.includes(s.when.equals as (typeof LEAD_TYPES)[number])
    );
    expect(typeGated).toHaveLength(6); // 3 SMS per intro arm x 2 arms
    // Routes gate on route_variant, which also answers "none" without a
    // phone, so no route (pinned or default) can fire either.
    const routeGated = allSteps(def).filter((s) => s.when?.var === "route_variant");
    expect(routeGated).toHaveLength(3 + DEFAULT_PINNABLE_TEAMMATES.length);
    for (const r of routeGated) {
      expect(r.when?.equals).not.toBe("none");
    }
    // …and the honest notify names what did NOT happen.
    const noPhone = step(def, "notify_no_phone");
    expect(noPhone.type).toBe("notify_owner");
    expect(noPhone.when).toEqual({ var: "phone_lead_type", equals: "none" });
    expect(String(noPhone.message)).toContain("NO usable phone number");
  });

  it("offer copy carries the lead card and the Amy (direct) source line", () => {
    const def = buildDefinition();
    for (const type of LEAD_TYPES) {
      const route = step(def, `route_${type}`);
      const offer = String(route.offerTemplate);
      expect(offer).toContain("{{vars.lead_phone}}");
      expect(offer).toContain("{{vars.lead_details}}");
      expect(offer).toContain("{{offer.deadline}}");
      expect(offer).toContain("Lead source: Amy (direct)");
      expect(String(route.ownerFallbackTemplate)).toContain("Lead source: Amy (direct)");
    }
  });

  it("honors an overridden agent and mailbox (both intro arms)", () => {
    const def = buildDefinition({
      agentName: "Gabrielle Mota",
      mailboxConnectionId: "11111111-2222-4333-8444-555555555555"
    });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(step(def, "route_seller").agentName).toBe("Gabrielle Mota");
    for (const id of ["email_lead_buyer", "email_lead_buyer_ref"]) {
      expect(step(def, id).fromConnectionId).toBe("11111111-2222-4333-8444-555555555555");
    }
    for (const id of ["send_buyer", "send_buyer_ref"]) {
      const send = step(def, id) as Step & {
        quietHours?: { emailFromConnectionId?: string };
      };
      expect(send.quietHours?.emailFromConnectionId).toBe(
        "11111111-2222-4333-8444-555555555555"
      );
    }
  });
});
