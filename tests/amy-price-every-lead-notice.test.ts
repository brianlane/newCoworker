import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_PRICE_FIELD,
  PATCH_PLAN,
  PRICE_LINE,
  REALTOR_PRICE_LINE,
  SPOKE_CHECK_PRICE_FIELD,
  patchDefinition,
  readTemplate,
  withExtractField,
  withPriceShown,
  writeTemplate
} from "../scripts/oneshot/amy-price-every-lead-notice";
import { CLEVER_PRICE_FIELD } from "../scripts/oneshot/amy-lead-price-in-notices";

/**
 * The Aug 7 script put the price on the two flows Amy had a notice from. This
 * one covers the rest of the account, so the tests that matter are about
 * COVERAGE (no team-facing template left behind) and about the two mechanical
 * traps this account keeps re-learning:
 *
 *   - route_to_team renders with no collapseEmpty, so a price var that can come
 *     back empty texts a teammate a bare "Price:" label;
 *   - a step or key that has been renamed must abort the run, not produce a
 *     three-quarters-applied policy (the agent_tool_settings lesson).
 */

const LEAD_SOURCE = "Lead source: Clever (listwithclever.com)";

describe("readTemplate / writeTemplate", () => {
  it("reads and writes a nested reminder template", () => {
    const step = { id: "route", unclaimedReminders: { rounds: 3, detailsTemplate: "Address: x" } };
    expect(readTemplate(step, "unclaimedReminders.detailsTemplate")).toBe("Address: x");
    writeTemplate(step, "unclaimedReminders.detailsTemplate", "Address: x\nPrice: y");
    expect(step.unclaimedReminders.detailsTemplate).toBe("Address: x\nPrice: y");
  });

  it("reads undefined rather than throwing when the parent is absent", () => {
    expect(readTemplate({ id: "route" }, "unclaimedReminders.detailsTemplate")).toBeUndefined();
  });

  it("refuses to write through a missing parent instead of inventing one", () => {
    // Creating the object would mean shipping a reminder ladder nobody
    // configured, with rounds/intervalMinutes missing.
    expect(() => writeTemplate({ id: "route" }, "unclaimedReminders.detailsTemplate", "x")).toThrow(
      /not an object/
    );
  });
});

describe("withPriceShown", () => {
  /**
   * Most of these notices already say the price in a sentence rather than on a
   * labelled line. Testing for the LINE would have texted the figure twice, in
   * the sentence and again underneath it. Every one of these prose forms is
   * live copy from Amy's account.
   */
  it.each([
    "New HomeLight referral: Marla, seller in San Tan Valley, AZ (~{{vars.price}}).",
    "New seller lead: Joe in Mesa, around {{vars.price}}. Contact: called twice.",
    "HIGH-VALUE lead ($1M+)\nJoe ({{vars.lead_phone}}) around {{vars.price}}."
  ])("leaves prose that already names the price var alone: %s", (tpl) => {
    expect(withPriceShown(tpl, PRICE_LINE)).toBe(tpl);
  });

  it("adds the line when the price is genuinely absent", () => {
    expect(withPriceShown("Dave claimed Joe\nAddress: 1 Main St", PRICE_LINE)).toBe(
      `Dave claimed Joe\n${PRICE_LINE}\nAddress: 1 Main St`
    );
  });

  it("matches on the flow's OWN price var, not any price-ish var", () => {
    // Realtor.com stores the figure under lead_price_details; a notice carrying
    // only the routing token must still gain a real figure.
    const bandOnly = "Realtor.com lead Joe\nBand: {{vars.price_band}}";
    expect(withPriceShown(bandOnly, REALTOR_PRICE_LINE)).toContain(REALTOR_PRICE_LINE);
    expect(withPriceShown("Joe {{vars.lead_price_details}}", REALTOR_PRICE_LINE)).toBe(
      "Joe {{vars.lead_price_details}}"
    );
  });
});

describe("withExtractField", () => {
  it("inserts before the named anchor so related figures read together", () => {
    const step = { id: "read_page", fields: [{ name: "lead_address" }, { name: "cash_offers" }] };
    expect(withExtractField(step, SPOKE_CHECK_PRICE_FIELD, "cash_offers")).toBe(true);
    expect(step.fields.map((f) => f.name)).toEqual(["lead_address", "price", "cash_offers"]);
  });

  it("appends when the anchor is not there", () => {
    const step = { id: "read_page", fields: [{ name: "lead_address" }] };
    withExtractField(step, SPOKE_CHECK_PRICE_FIELD, "cash_offers");
    expect(step.fields.map((f) => f.name)).toEqual(["lead_address", "price"]);
  });

  it("does not add a second copy", () => {
    const step = { id: "read_page", fields: [{ name: "price" }] };
    expect(withExtractField(step, SPOKE_CHECK_PRICE_FIELD)).toBe(false);
    expect(step.fields).toHaveLength(1);
  });
});

describe("the new extraction fields", () => {
  // Without this the teammate gets "Price:" and nothing after it.
  it("both tell the model to answer none rather than leave the field empty", () => {
    expect(SPOKE_CHECK_PRICE_FIELD.description).toContain("answer exactly: none");
    expect(FOLLOWUP_PRICE_FIELD.description).toContain("answer exactly: none");
  });

  // The spoke check browses the SAME Clever lead page the accept flow does.
  // Two wordings for one number is how the two drift apart.
  it("words the Clever lead page identically to the accept flow's field", () => {
    expect(SPOKE_CHECK_PRICE_FIELD.name).toBe(CLEVER_PRICE_FIELD.name);
    expect(SPOKE_CHECK_PRICE_FIELD.description).toBe(CLEVER_PRICE_FIELD.description);
  });

  // Follow Up Requested reads an event notice, not a page: an invented figure
  // would be texted to a teammate as fact.
  it("forbids guessing on the flow with no lead page", () => {
    expect(FOLLOWUP_PRICE_FIELD.description).toContain("Do not guess");
  });
});

describe("PATCH_PLAN coverage", () => {
  it("uses Realtor.com's own price var for Realtor.com and the shared one elsewhere", () => {
    expect(PATCH_PLAN["Realtor.com Lead"].line).toBe(REALTOR_PRICE_LINE);
    for (const [name, plan] of Object.entries(PATCH_PLAN)) {
      if (name !== "Realtor.com Lead") expect(plan.line).toBe(PRICE_LINE);
    }
  });

  // Every route_to_team step named in the plan must have all four of its
  // outbound templates listed, or the next partial-coverage bug is already
  // written: the offer says the price and the claim confirmation does not.
  it("names every reminder details template beside its route step", () => {
    for (const [name, plan] of Object.entries(PATCH_PLAN)) {
      const routeSteps = new Set(
        plan.targets.filter(([, k]) => k === "offerTemplate").map(([s]) => s)
      );
      for (const step of routeSteps) {
        for (const key of ["ownerFallbackTemplate", "unclaimedReminders.detailsTemplate"]) {
          expect(
            plan.targets.some(([s, k]) => s === step && k === key),
            `${name}: ${step} is missing ${key}`
          ).toBe(true);
        }
      }
    }
  });

  it("only adds an extraction field to the two flows that had no price", () => {
    const withField = Object.entries(PATCH_PLAN)
      .filter(([, p]) => p.field)
      .map(([n]) => n);
    expect(withField.sort()).toEqual([
      "Clever - Spoke Check & Weekly Call Follow-Up",
      "Follow Up Requested (Unclaimed Leads)"
    ]);
  });
});

describe("patchDefinition", () => {
  const spokeDef = () => ({
    steps: [
      { id: "read_page", type: "browse_extract", fields: [{ name: "lead_address" }, { name: "cash_offers" }] },
      {
        id: "spoke_check",
        type: "route_to_team",
        offerTemplate: "Follow-up check on Joe\nAddress: 1 Main St\nDid you speak with them?",
        claimedNotifyTemplate: "Dave confirmed\nAddress: 1 Main St",
        ownerFallbackTemplate: "Joe hasn't been reached\nAddress: 1 Main St",
        unclaimedReminders: { rounds: 3, intervalMinutes: 20, detailsTemplate: "Address: 1 Main St" }
      },
      { id: "wrap_up", type: "notify_owner", message: "Clever follow-up finished for Joe.\nAddress: 1 Main St" }
    ]
  });

  it("adds the field and a price line to every spoke-check notice", () => {
    const def = spokeDef();
    const res = patchDefinition("Clever - Spoke Check & Weekly Call Follow-Up", def);
    expect(res.changed).toBe(true);
    expect(res.touched).toEqual([
      "read_page.fields",
      "spoke_check.offerTemplate",
      "spoke_check.claimedNotifyTemplate",
      "spoke_check.ownerFallbackTemplate",
      "spoke_check.unclaimedReminders.detailsTemplate",
      "wrap_up.message"
    ]);
    // The reminder is a single line, so the price appends rather than
    // displacing the address.
    expect(def.steps[1].unclaimedReminders?.detailsTemplate).toBe(
      `Address: 1 Main St\n${PRICE_LINE}`
    );
  });

  it("is a no-op on a second run", () => {
    const def = spokeDef();
    patchDefinition("Clever - Spoke Check & Weekly Call Follow-Up", def);
    const again = patchDefinition("Clever - Spoke Check & Weekly Call Follow-Up", def);
    expect(again.changed).toBe(false);
    expect(again.touched).toEqual([]);
  });

  it("leaves a template that already carries the price untouched", () => {
    const def = {
      steps: [
        {
          id: "route",
          type: "route_to_team",
          offerTemplate: `New Clever lead: Joe\n${PRICE_LINE}\n${LEAD_SOURCE}`,
          // Prose form, the way most of the live notices carry it.
          ownerDirectTemplate: "HIGH-VALUE\nJoe in Mesa, around {{vars.price}}.",
          claimedNotifyTemplate: `Dave claimed Joe\n${PRICE_LINE}`,
          ownerFallbackTemplate: `No agent claimed Joe\n${PRICE_LINE}`,
          unclaimedReminders: { rounds: 3, intervalMinutes: 20, detailsTemplate: "Address: 1 Main St" }
        },
        { id: "call_gap_alert", type: "notify_owner", message: `Heads up: no call\n${PRICE_LINE}` },
        { id: "call_fail_alert", type: "notify_owner", message: `Call FAILED\n${PRICE_LINE}` },
        { id: "notify", type: "notify_owner", message: `Clever lead: Joe\n${PRICE_LINE}` },
        { id: "bp_forward", type: "notify_owner", message: `Update from Dave\n${PRICE_LINE}` }
      ]
    };
    const res = patchDefinition("Clever Lead - Accept", def);
    // Only the reminder line was actually missing it.
    expect(res.touched).toEqual(["route.unclaimedReminders.detailsTemplate"]);
  });

  // Aborting beats guessing: a renamed step means the live flow moved.
  it("throws rather than half-patching when a step is missing", () => {
    const def = { steps: [{ id: "read_page", type: "browse_extract", fields: [] }] };
    expect(() => patchDefinition("Clever - Spoke Check & Weekly Call Follow-Up", def)).toThrow(
      /step "spoke_check" is missing/
    );
  });

  it("throws when the template key it expects is not there", () => {
    const def = spokeDef();
    delete (def.steps[1] as Record<string, unknown>).claimedNotifyTemplate;
    expect(() => patchDefinition("Clever - Spoke Check & Weekly Call Follow-Up", def)).toThrow(
      /no claimedNotifyTemplate to patch/
    );
  });

  it("throws when the reminder ladder it expects is not configured", () => {
    const def = spokeDef();
    delete (def.steps[1] as Record<string, unknown>).unclaimedReminders;
    expect(() => patchDefinition("Clever - Spoke Check & Weekly Call Follow-Up", def)).toThrow(
      /no unclaimedReminders\.detailsTemplate to patch/
    );
  });

  it("throws when the field step it expects is missing", () => {
    const def = { steps: [{ id: "route_buyer", type: "route_to_team" }] };
    expect(() => patchDefinition("Follow Up Requested (Unclaimed Leads)", def)).toThrow(
      /step "read_request" is missing/
    );
  });

  it("refuses a flow it has no plan for", () => {
    expect(() => patchDefinition("Some Other Flow", { steps: [] })).toThrow(/no patch plan/);
  });

  it("treats a definition with no steps array as an empty flow", () => {
    expect(() => patchDefinition("Clever Lead - Accept", {})).toThrow(/step "route" is missing/);
  });
});
