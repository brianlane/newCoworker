import { describe, expect, it } from "vitest";
import {
  CLEVER_PRICE_FIELD,
  CLEVER_PRICE_LINE,
  REALTOR_PRICE_LINE,
  findStep,
  patchDefinition,
  withPriceField,
  withPriceLine
} from "../scripts/oneshot/amy-lead-price-in-notices";

/**
 * Amy asked for the price to show on every lead notice. Two things decide
 * whether that request is actually met:
 *
 *   - Clever has to EXTRACT the figure first; it only ever pulled the
 *     over/under-$1M routing token, so there was nothing to template;
 *   - no notice may end up with a bare "Price:" label, because route_to_team
 *     renders its templates with no collapseEmpty, so an empty var reaches a
 *     teammate as a dangling label.
 */

const LEAD_SOURCE = "Lead source: Clever (listwithclever.com)";

describe("withPriceLine", () => {
  it("places the line directly before the lead-source line", () => {
    const out = withPriceLine(
      `New Clever lead: Joe\nAddress: 1 Main St\n${LEAD_SOURCE}\nReply 1 to claim.`,
      CLEVER_PRICE_LINE
    );
    const lines = out.split("\n");
    expect(lines[2]).toBe(CLEVER_PRICE_LINE);
    expect(lines[3]).toBe(LEAD_SOURCE);
  });

  it("falls back to just after the opening line when there is no lead source", () => {
    const out = withPriceLine("Header line\nSecond line", CLEVER_PRICE_LINE);
    expect(out.split("\n")[1]).toBe(CLEVER_PRICE_LINE);
  });

  it("appends to a single-line notice", () => {
    expect(withPriceLine("Only one line", CLEVER_PRICE_LINE)).toBe(
      `Only one line\n${CLEVER_PRICE_LINE}`
    );
  });

  // Idempotence is what lets the one-shot be re-run safely, which the repo's
  // whole one-shot convention depends on.
  it("is a no-op when the line is already present", () => {
    const already = `New lead\n${CLEVER_PRICE_LINE}\n${LEAD_SOURCE}`;
    expect(withPriceLine(already, CLEVER_PRICE_LINE)).toBe(already);
  });

  it("keeps the two flows' lines distinct", () => {
    // Realtor.com stores the figure under a different var; sharing one line
    // would template a var that flow does not have.
    expect(CLEVER_PRICE_LINE).not.toBe(REALTOR_PRICE_LINE);
    expect(REALTOR_PRICE_LINE).toContain("lead_price_details");
  });
});

describe("withPriceField", () => {
  it("inserts price directly before price_band so the two read together", () => {
    const step = { id: "read_details", fields: [{ name: "lead_name" }, { name: "price_band" }] };
    expect(withPriceField(step)).toBe(true);
    expect(step.fields.map((f) => f.name)).toEqual(["lead_name", "price", "price_band"]);
  });

  it("appends when there is no price_band to anchor to", () => {
    const step = { id: "read_details", fields: [{ name: "lead_name" }] };
    withPriceField(step);
    expect(step.fields.map((f) => f.name)).toEqual(["lead_name", "price"]);
  });

  it("does not add a second copy", () => {
    const step = { id: "read_details", fields: [{ name: "price" }, { name: "price_band" }] };
    expect(withPriceField(step)).toBe(false);
    expect(step.fields).toHaveLength(2);
  });

  // The "none" fallback is what stops a page with no figure producing a bare
  // "Price:" label on a teammate's phone.
  it("tells the model to answer none rather than leave the field empty", () => {
    expect(CLEVER_PRICE_FIELD.description).toContain("answer exactly: none");
  });
});

describe("findStep", () => {
  it("reaches a step nested inside a branch arm", () => {
    const steps = [
      { id: "a", type: "send_sms" },
      {
        id: "b",
        type: "branch",
        branches: [{ id: "arm", steps: [{ id: "deep", type: "send_email" }] }],
        else: [{ id: "elsewhere", type: "notify_owner" }]
      }
    ];
    expect(findStep(steps, "deep")?.id).toBe("deep");
    expect(findStep(steps, "elsewhere")?.id).toBe("elsewhere");
    expect(findStep(steps, "nope")).toBeNull();
  });
});

describe("patchDefinition", () => {
  const cleverDef = () => ({
    steps: [
      { id: "read_details", type: "browse_extract", fields: [{ name: "price_band" }] },
      { id: "qt_email", type: "send_email", body: `New Clever lead accepted: Joe\n${LEAD_SOURCE}` },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: `New Clever lead: Joe\n${LEAD_SOURCE}\nReply 1 to claim.`,
        ownerDirectTemplate: `HIGH-VALUE Clever lead\nJoe\n${LEAD_SOURCE}`,
        claimedNotifyTemplate: `Dave claimed Joe\n${LEAD_SOURCE}`,
        ownerFallbackTemplate: `No agent claimed Joe\n${LEAD_SOURCE}`
      },
      { id: "notify", type: "notify_owner", message: `Clever lead: Joe\n${LEAD_SOURCE}` }
    ]
  });

  it("adds the field and every notice line for Clever", () => {
    const def = cleverDef();
    const res = patchDefinition("Clever Lead - Accept", def);
    expect(res.changed).toBe(true);
    expect(res.touched).toContain("read_details.fields");
    // Every teammate-facing notice, not just the one somebody looked at.
    for (const t of [
      "qt_email.body",
      "route.offerTemplate",
      "route.ownerDirectTemplate",
      "route.claimedNotifyTemplate",
      "route.ownerFallbackTemplate",
      "notify.message"
    ]) {
      expect(res.touched).toContain(t);
    }
  });

  it("is a no-op on a second run", () => {
    const def = cleverDef();
    patchDefinition("Clever Lead - Accept", def);
    expect(patchDefinition("Clever Lead - Accept", def).changed).toBe(false);
  });

  // Aborting beats guessing: a renamed step means the live flow moved and the
  // script's assumptions need re-checking, not a silent partial patch.
  it("throws rather than half-patching when a step is missing", () => {
    const def = { steps: [{ id: "read_details", type: "browse_extract", fields: [] }] };
    expect(() => patchDefinition("Clever Lead - Accept", def)).toThrow(/qt_email/);
  });

  it("throws when the template key it expects is not a string", () => {
    const def = cleverDef();
    delete (def.steps[3] as Record<string, unknown>).message;
    expect(() => patchDefinition("Clever Lead - Accept", def)).toThrow(/no message to patch/);
  });

  it("touches only the two Realtor.com notices that lack the price", () => {
    const def = {
      steps: [
        {
          id: "s4",
          type: "route_to_team",
          offerTemplate: `New Realtor.com lead ${REALTOR_PRICE_LINE}`,
          claimedNotifyTemplate: "Dave claimed Joe\nLead source: Realtor.com (realtor.com)",
          ownerFallbackTemplate: "No agent claimed Joe\nLead source: Realtor.com (realtor.com)"
        }
      ]
    };
    const res = patchDefinition("Realtor.com Lead", def);
    expect(res.touched).toEqual(["s4.claimedNotifyTemplate", "s4.ownerFallbackTemplate"]);
    // The offer already carried it and must not gain a duplicate line.
    expect((def.steps[0] as { offerTemplate: string }).offerTemplate).toBe(
      `New Realtor.com lead ${REALTOR_PRICE_LINE}`
    );
  });

  it("refuses a flow it has no plan for", () => {
    expect(() => patchDefinition("Some Other Flow", { steps: [] })).toThrow(/no patch plan/);
  });
});
