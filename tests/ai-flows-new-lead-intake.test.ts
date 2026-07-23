import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  buildDefinition,
  DEFAULT_FLOW_NAME
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
 *   - the $1M+ keep-for-owner rule is present on every route variant;
 *   - quiet hours guard every lead-facing SMS;
 *   - buyer route is un-pinned (roster cascade), seller/both pin Dave.
 */

type Step = Record<string, unknown> & {
  id: string;
  type: string;
  when?: { var: string; equals?: string; notEquals?: string };
};

function stepsOf(def: unknown): Step[] {
  return (def as { steps: Step[] }).steps;
}

function step(def: unknown, id: string): Step {
  const found = stepsOf(def).find((s) => s.id === id);
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
      fields: { name: string }[];
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
      "email_intro_type"
    ]) {
      expect(names).toContain(required);
    }
  });

  it("gates the contact upsert on a parsed phone (upsert fails hard on 'none')", () => {
    const save = step(buildDefinition(), "save_contact");
    expect(save.type).toBe("upsert_customer");
    expect(save.when).toEqual({ var: "phone_lead_type", notEquals: "none" });
    expect(save.phoneVar).toBe("lead_phone");
    expect(save.nameVar).toBe("lead_name");
    expect(save.emailVar).toBe("lead_email");
  });

  it("intro SMS variants gate on exact lead-type tokens with quiet hours", () => {
    const def = buildDefinition();
    for (const type of LEAD_TYPES) {
      const send = step(def, `send_${type}`) as Step & {
        quietHours?: { noSendAfter?: string; emailFallbackVar?: string };
      };
      expect(send.type).toBe("send_sms");
      expect(send.to).toBe("{{vars.lead_phone}}");
      expect(send.when).toEqual({ var: "phone_lead_type", equals: type });
      expect(send.quietHours?.noSendAfter).toBe("22:00");
      expect(send.quietHours?.emailFallbackVar).toBe("lead_email");
    }
  });

  it("no-phone leads get the intro by email only (email_intro_type gate)", () => {
    const def = buildDefinition();
    for (const type of LEAD_TYPES) {
      const email = step(def, `email_lead_${type}`);
      expect(email.type).toBe("send_email");
      expect(email.to).toBe("{{vars.lead_email}}");
      expect(email.when).toEqual({ var: "email_intro_type", equals: type });
      expect(email.fromConnectionId).toBeTruthy();
    }
  });

  it("routes gate on a parsed phone; buyer is un-pinned, seller/both pin the agent", () => {
    const def = buildDefinition({ agentName: "Dave Lane" });
    for (const type of LEAD_TYPES) {
      const route = step(def, `route_${type}`);
      expect(route.type).toBe("route_to_team");
      expect(route.when).toEqual({ var: "phone_lead_type", equals: type });
      if (type === "buyer") {
        expect(route.agentName).toBeUndefined();
        expect(route.agentNames).toBeUndefined();
      } else {
        expect(route.agentName).toBe("Dave Lane");
      }
    }
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
    const phoneGated = stepsOf(def).filter(
      (s) => s.when?.var === "phone_lead_type" && s.when.notEquals === "none"
    );
    expect(phoneGated.map((s) => s.id)).toEqual(["save_contact", "notify"]);
    const typeGated = stepsOf(def).filter(
      (s) =>
        s.when?.var === "phone_lead_type" &&
        LEAD_TYPES.includes(s.when.equals as (typeof LEAD_TYPES)[number])
    );
    expect(typeGated).toHaveLength(6); // 3 sends + 3 routes
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

  it("honors an overridden agent and mailbox", () => {
    const def = buildDefinition({
      agentName: "Gabrielle Mota",
      mailboxConnectionId: "11111111-2222-4333-8444-555555555555"
    });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(step(def, "route_seller").agentName).toBe("Gabrielle Mota");
    expect(step(def, "email_lead_buyer").fromConnectionId).toBe(
      "11111111-2222-4333-8444-555555555555"
    );
    const send = step(def, "send_buyer") as Step & {
      quietHours?: { emailFromConnectionId?: string };
    };
    expect(send.quietHours?.emailFromConnectionId).toBe(
      "11111111-2222-4333-8444-555555555555"
    );
  });
});
