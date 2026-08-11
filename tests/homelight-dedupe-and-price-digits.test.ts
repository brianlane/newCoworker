import { describe, expect, it } from "vitest";
import {
  DEDUPE_VAR,
  PRICE_DIGITS_DESCRIPTION,
  patchHomeLight
} from "../scripts/oneshot/homelight-dedupe-and-price-digits";

/**
 * Two Aug 11 2026 findings from one pair of HomeLight runs: the same alert
 * arrived twice and both deliveries spawned a run that texted the same
 * teammate, and the same alert produced two different price_digits values.
 */

const def = () => ({
  options: { startImmediately: true },
  steps: [
    { id: "url", type: "extract_url", saveAs: "leadUrl" },
    {
      id: "alert",
      type: "extract_text",
      fields: [
        { name: "lead_first_name", description: "The lead's first name" },
        { name: "price_digits", description: "The price's leading digits ONLY, no $, commas, K or M." }
      ]
    },
    { id: "route", type: "route_to_team", offerTemplate: "New referral" }
  ]
});

describe("patchHomeLight", () => {
  it("turns on the dedupe and keys it on the referral link", () => {
    const d = def();
    const res = patchHomeLight(d);
    expect(res.changed).toBe(true);
    expect(d.options).toMatchObject({
      dedupeLeadRuns: true,
      dedupeLeadRunsByVar: DEDUPE_VAR,
      // Existing options survive.
      startImmediately: true
    });
    expect(res.touched).toContain("alert.price_digits.description");
  });

  it("is a no-op on a second run", () => {
    const d = def();
    patchHomeLight(d);
    expect(patchHomeLight(d).changed).toBe(false);
  });

  /**
   * The wording is the fix. $507,258 is the figure that produced both "507"
   * and "507258", so it has to have one stated answer.
   */
  it("gives a full-precision figure exactly one right answer", () => {
    expect(PRICE_DIGITS_DESCRIPTION).toContain("$507,258 answer 507");
    expect(PRICE_DIGITS_DESCRIPTION).toContain("first three digits");
    // Extraction field descriptions cap at 300 characters; the validator
    // rejected the first attempt at this wording before it could be written.
    expect(PRICE_DIGITS_DESCRIPTION.length).toBeLessThanOrEqual(300);
    // The two examples that were already being answered correctly stay.
    expect(PRICE_DIGITS_DESCRIPTION).toContain("$429K answer 429");
    expect(PRICE_DIGITS_DESCRIPTION).toContain("$264,000 answer 264");
  });

  /**
   * The dedupe key must be produced BEFORE the first comm step, which is the
   * assumption the whole fix rests on: dedupeLeadRuns is inert on this flow
   * precisely because phone and email arrive too late.
   */
  it("refuses to set a key the flow never produces", () => {
    const d = def();
    d.steps[0].saveAs = "somethingElse";
    expect(() => patchHomeLight(d)).toThrow(/does not save leadUrl/);
    const missing = def();
    missing.steps.shift();
    expect(() => patchHomeLight(missing)).toThrow(/does not save leadUrl/);
  });

  it("aborts rather than half-patching when the alert step moved", () => {
    const d = def();
    d.steps[1].id = "alert_v2";
    expect(() => patchHomeLight(d)).toThrow(/step "alert" is missing/);
    const noField = def();
    noField.steps[1].fields = [{ name: "city", description: "x" }];
    expect(() => patchHomeLight(noField)).toThrow(/no price_digits field/);
  });
});
