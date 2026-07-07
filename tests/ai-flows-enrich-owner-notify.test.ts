import { describe, expect, it } from "vitest";
import {
  enrichOwnerNotify,
  NOTIFY_MESSAGES,
  CLEVER_NOTIFY_STEP
} from "../scripts/oneshot/enrich-owner-notify";

type Step = Record<string, unknown> & { id?: string; type?: string };
type Def = { steps: Step[] };

describe("enrichOwnerNotify", () => {
  it("rewrites the HomeLight notify to include personal info + address", () => {
    const def: Def = {
      steps: [
        {
          id: "notify",
          type: "notify_owner",
          message:
            "HomeLight referral: {{vars.lead_first_name}} ({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}).\nOutcome: {{vars.actions_taken}}."
        }
      ]
    };
    expect(enrichOwnerNotify(def, "HomeLight Referral")).toBe(true);
    const msg = def.steps[0].message as string;
    expect(msg).toContain("Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}");
    expect(msg).toContain("Address: {{vars.lead_address}}");
    expect(msg).toContain("~{{vars.price}}");
    expect(msg).toContain("Outcome: {{vars.actions_taken}}");
  });

  it("rewrites the Realtor.com notify (previously outcome-only) with full lead details", () => {
    const def: Def = {
      steps: [
        { id: "s5", type: "notify_owner", message: "Realtor.com Lead Routing Update: {{vars.actions_taken}}" }
      ]
    };
    expect(enrichOwnerNotify(def, "Realtor.com Lead")).toBe(true);
    expect(def.steps[0].message).toBe(NOTIFY_MESSAGES["Realtor.com Lead"].s5);
  });

  it("appends the missing notify_owner step to Clever Lead - Accept", () => {
    const def: Def = { steps: [{ id: "route", type: "route_to_team" }] };
    expect(enrichOwnerNotify(def, "Clever Lead - Accept")).toBe(true);
    const added = def.steps.at(-1)!;
    expect(added.type).toBe("notify_owner");
    expect(added.message).toBe(CLEVER_NOTIFY_STEP.message);
    // Never doubled if one already exists.
    expect(enrichOwnerNotify(def, "Clever Lead - Accept")).toBe(false);
    expect(def.steps.filter((s) => s.type === "notify_owner")).toHaveLength(1);
  });

  it("upgrades every lead_address extraction to demand the full address with ZIP", () => {
    const def: Def = {
      steps: [
        {
          id: "card",
          type: "browse_extract",
          fields: [
            { name: "lead_address", description: "The property street address from the contact card" },
            { name: "lead_phone", description: "The lead's phone" }
          ]
        },
        {
          id: "email_card",
          type: "email_extract",
          fields: [{ name: "lead_address", description: "The property street address" }]
        }
      ]
    };
    expect(enrichOwnerNotify(def, "Anything")).toBe(true);
    const fields = def.steps.flatMap(
      (s) => (s.fields as Array<{ name: string; description: string }>) ?? []
    );
    for (const f of fields.filter((f) => f.name === "lead_address")) {
      expect(f.description).toContain("ZIP");
      expect(f.description).toContain("city");
    }
    // Untouched fields stay untouched.
    expect(fields.find((f) => f.name === "lead_phone")?.description).toBe("The lead's phone");
  });

  it("is idempotent and leaves unknown flows without address fields unchanged", () => {
    const def: Def = {
      steps: [
        { id: "notify", type: "notify_owner", message: NOTIFY_MESSAGES["HomeLight Referral"].notify },
        {
          id: "card",
          type: "browse_extract",
          fields: [{ name: "lead_address", description: "Full address including ZIP" }]
        }
      ]
    };
    expect(enrichOwnerNotify(def, "HomeLight Referral")).toBe(false);

    const untouched: Def = { steps: [{ id: "x", type: "send_sms" }] };
    expect(enrichOwnerNotify(untouched, "Some Other Flow")).toBe(false);
  });

  it("ignores notify steps whose id has no configured rewrite (and steps without ids)", () => {
    const def: Def = {
      steps: [
        { id: "other", type: "notify_owner", message: "custom" },
        { type: "notify_owner", message: "no-id" }
      ]
    };
    expect(enrichOwnerNotify(def, "HomeLight Referral")).toBe(false);
    expect(def.steps[0].message).toBe("custom");
  });
});
