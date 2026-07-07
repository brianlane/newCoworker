import { describe, expect, it } from "vitest";
import {
  enrichOwnerNotify,
  NOTIFY_MESSAGES,
  CLEVER_NOTIFY_STEP,
  HOMELIGHT_NOTIFY_CLAIMED,
  HOMELIGHT_NOTIFY_UNCLAIMED_STEP
} from "../scripts/oneshot/enrich-owner-notify";

type Step = Record<string, unknown> & { id?: string; type?: string };
type Def = { steps: Step[] };

describe("enrichOwnerNotify", () => {
  it("splits the HomeLight notify into a full-details claimed branch and an unclaimed branch", () => {
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
    // Claimed branch: full contact details, gated on a claim (the contact
    // extraction steps only run post-claim).
    const claimed = def.steps.find((s) => s.id === "notify")!;
    expect(claimed.message).toBe(HOMELIGHT_NOTIFY_CLAIMED);
    expect(claimed.message).toContain(
      "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}"
    );
    expect(claimed.message).toContain("Address: {{vars.lead_address}}");
    expect(claimed.when).toEqual({ var: "claimed_agent", notEquals: "none" });
    // Unclaimed branch: alert-level fields + portal link, no empty lines.
    const unclaimed = def.steps.find((s) => s.id === "notify_unclaimed")!;
    expect(unclaimed.message).toBe(HOMELIGHT_NOTIFY_UNCLAIMED_STEP.message);
    expect(unclaimed.when).toEqual({ var: "claimed_agent", equals: "none" });
    expect(def.steps.indexOf(unclaimed)).toBe(def.steps.indexOf(claimed) + 1);
    // Idempotent.
    expect(enrichOwnerNotify(def, "HomeLight Referral")).toBe(false);
    expect(def.steps.filter((s) => s.type === "notify_owner")).toHaveLength(2);
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
        {
          id: "notify",
          type: "notify_owner",
          message: HOMELIGHT_NOTIFY_CLAIMED,
          when: { var: "claimed_agent", notEquals: "none" }
        },
        JSON.parse(JSON.stringify(HOMELIGHT_NOTIFY_UNCLAIMED_STEP)),
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

    const realtorDone: Def = {
      steps: [{ id: "s5", type: "notify_owner", message: NOTIFY_MESSAGES["Realtor.com Lead"].s5 }]
    };
    expect(enrichOwnerNotify(realtorDone, "Realtor.com Lead")).toBe(false);
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
