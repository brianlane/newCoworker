import { describe, expect, it } from "vitest";
import {
  addPriceBandRouting,
  OWNER_DIRECT_WHEN,
  PRICE_BAND_FLOWS
} from "../scripts/oneshot/add-price-band-routing";

type Field = { name?: string; description?: string };
type Step = Record<string, unknown> & {
  id?: string;
  type?: string;
  fields?: Field[];
  ownerDirectWhen?: unknown;
  ownerDirectTemplate?: unknown;
};
type Def = { steps: Step[] };

function homelightDef(): Def {
  return {
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "alert",
        type: "extract_text",
        fields: [{ name: "lead_first_name" }, { name: "price" }]
      },
      { id: "route", type: "route_to_team", offerTemplate: "x", ownerFallbackTemplate: "y" }
    ]
  };
}

describe("addPriceBandRouting", () => {
  it("adds price_band extraction + the keep-for-owner rule to HomeLight", () => {
    const def = homelightDef();
    expect(addPriceBandRouting(def, "HomeLight Referral")).toBe(true);

    const alert = def.steps.find((s) => s.id === "alert")!;
    const band = alert.fields!.find((f) => f.name === "price_band")!;
    expect(band.description).toContain("over_1m or under_1m");
    expect(band.description).toContain("If no price is shown, answer under_1m");

    const route = def.steps.find((s) => s.id === "route")!;
    expect(route.ownerDirectWhen).toEqual(OWNER_DIRECT_WHEN);
    expect(route.ownerDirectTemplate).toBe(
      PRICE_BAND_FLOWS["HomeLight Referral"].ownerDirectTemplates.route
    );
  });

  it("is idempotent (second run changes nothing)", () => {
    const def = homelightDef();
    expect(addPriceBandRouting(def, "HomeLight Referral")).toBe(true);
    const snapshot = JSON.stringify(def);
    expect(addPriceBandRouting(def, "HomeLight Referral")).toBe(false);
    expect(JSON.stringify(def)).toBe(snapshot);
  });

  it("preserves a manually tweaked rule instead of clobbering it on re-run", () => {
    const def = homelightDef();
    addPriceBandRouting(def, "HomeLight Referral");
    const route = def.steps.find((s) => s.id === "route")!;
    route.ownerDirectTemplate = "Amy's own wording";
    expect(addPriceBandRouting(def, "HomeLight Referral")).toBe(false);
    expect(route.ownerDirectTemplate).toBe("Amy's own wording");
  });

  it("stamps ALL THREE ReferralExchange route branches (buyer/seller/both)", () => {
    const def: Def = {
      steps: [
        { id: "browse", type: "browse_extract", fields: [{ name: "price" }] },
        { id: "route_buyer", type: "route_to_team", when: { var: "phone_lead_type", equals: "buyer" } },
        { id: "route_seller", type: "route_to_team", when: { var: "phone_lead_type", equals: "seller" } },
        { id: "route_both", type: "route_to_team", when: { var: "phone_lead_type", equals: "both" } }
      ]
    };
    expect(addPriceBandRouting(def, "ReferralExchange Lead")).toBe(true);
    for (const id of ["route_buyer", "route_seller", "route_both"]) {
      const step = def.steps.find((s) => s.id === id)!;
      expect(step.ownerDirectWhen).toEqual(OWNER_DIRECT_WHEN);
      expect(typeof step.ownerDirectTemplate).toBe("string");
      // The existing lead-type gate must survive: gating on price_band happens
      // INSIDE route_to_team (ownerDirectWhen), not via the step's `when`.
      expect(step.when).toEqual({ var: "phone_lead_type", equals: expect.any(String) });
    }
  });

  it("stamps a seed-shaped ReferralExchange flow (single 'route' step, name case differs)", () => {
    // The seed creates "ReferralExchange lead" (lowercase l) with ONE route
    // step id "route" — the $1M rule must land there too, not only on Amy's
    // live route_buyer/route_seller/route_both branches.
    const def: Def = {
      steps: [
        { id: "browse", type: "browse_extract", fields: [{ name: "price" }] },
        { id: "route", type: "route_to_team" }
      ]
    };
    expect(addPriceBandRouting(def, "ReferralExchange lead")).toBe(true);
    const route = def.steps.find((s) => s.id === "route")!;
    expect(route.ownerDirectWhen).toEqual(OWNER_DIRECT_WHEN);
    expect(route.ownerDirectTemplate).toBe(
      PRICE_BAND_FLOWS["ReferralExchange Lead"].ownerDirectTemplates.route
    );
  });

  it("leaves unknown flows untouched", () => {
    const def: Def = {
      steps: [{ id: "route", type: "route_to_team" }]
    };
    expect(addPriceBandRouting(def, "Some Other Flow")).toBe(false);
    expect(def.steps[0].ownerDirectWhen).toBeUndefined();
  });

  it("covers every wired flow with a route template for each of its route steps", () => {
    // Sanity on the wiring table itself: every flow names an extract step and
    // at least one route template.
    for (const [name, wiring] of Object.entries(PRICE_BAND_FLOWS)) {
      expect(wiring.extractStepId, name).toBeTruthy();
      expect(Object.keys(wiring.ownerDirectTemplates).length, name).toBeGreaterThan(0);
      for (const tpl of Object.values(wiring.ownerDirectTemplates)) {
        expect(tpl).toContain("$1M+");
        expect(tpl).toContain("not offered to the team");
      }
    }
  });
});
