import { describe, expect, it } from "vitest";
import {
  CLEVER_ACCEPT_VOICEMAILS,
  NEW_LEAD_INTAKE_VOICEMAILS,
  SPOKE_CHECK_VOICEMAILS,
  VOICEMAIL_PLAN,
  patchVoicemails
} from "../scripts/oneshot/amy-voicemail-scripts";

/**
 * Spoken copy that goes to a lead unsupervised, so the rules this account
 * already has are pinned here rather than trusted to review.
 */

const ALL = Object.values(VOICEMAIL_PLAN).flatMap((f) => Object.entries(f));

describe("voicemail copy", () => {
  it.each(ALL)("%s stays inside the schema's 600-character cap", (_id, script) => {
    expect(script.length).toBeLessThanOrEqual(600);
  });

  it.each(ALL)("%s carries the callback number", (_id, script) => {
    expect(script).toContain("602-695-1142");
  });

  // The account-wide rule, and it applies to spoken copy too.
  it.each(ALL)("%s contains no em dash", (_id, script) => {
    expect(script).not.toContain("—");
  });

  /**
   * Amy's standing rule: never ask when is a good time to call back. She calls
   * back fast rather than booking an appointment to call. Leaving her number
   * is not that question.
   */
  it.each(ALL)("%s never asks when to call back", (_id, script) => {
    expect(script.toLowerCase()).not.toMatch(/good time|best time|when (would|is|can)/);
  });

  /**
   * The price is the referral network's estimate. Quoting it back at a seller
   * in an unsupervised voicemail is a valuation claim, and lead-facing copy on
   * this account deliberately does not (see amy-price-every-lead-notice.ts).
   */
  it.each(ALL)("%s quotes no price", (_id, script) => {
    expect(script).not.toMatch(/\{\{vars\.(price|lead_price_details)/);
    expect(script).not.toMatch(/\$[0-9]/);
  });

  it.each(ALL)("%s says who is calling", (_id, script) => {
    expect(script).toMatch(/Amy Laidlaw/);
  });

  // Product terminology, banned account-wide and fleet-wide.
  it.each(ALL)("%s never says AI receptionist", (_id, script) => {
    expect(script.toLowerCase()).not.toContain("receptionist");
  });
});

describe("per-rung wording", () => {
  /**
   * A ladder that redials leaves a message each time. Three identical
   * recordings from one number reads as a malfunction.
   */
  it("gives every rung of every ladder its own words", () => {
    for (const [flow, rungs] of Object.entries(VOICEMAIL_PLAN)) {
      const scripts = Object.values(rungs);
      expect(new Set(scripts).size, `${flow} repeats a message`).toBe(scripts.length);
    }
  });

  it("says the last message is the last one", () => {
    expect(CLEVER_ACCEPT_VOICEMAILS.ai_call_3.toLowerCase()).toContain("last message");
    expect(SPOKE_CHECK_VOICEMAILS.week_8_call.toLowerCase()).toContain("last call");
    // And warns one rung earlier, so it does not come out of nowhere.
    expect(SPOKE_CHECK_VOICEMAILS.week_7_call.toLowerCase()).toContain("one more message");
  });

  it("covers all eight weekly rungs and both intake languages", () => {
    expect(Object.keys(SPOKE_CHECK_VOICEMAILS)).toHaveLength(8);
    expect(Object.keys(NEW_LEAD_INTAKE_VOICEMAILS).sort()).toEqual(["call_lead_en", "call_lead_es"]);
    // The Spanish message is a translation of the English one, not a different
    // message: the lead's language must not change what they are told.
    expect(NEW_LEAD_INTAKE_VOICEMAILS.call_lead_es).toContain("Amy Laidlaw");
    expect(NEW_LEAD_INTAKE_VOICEMAILS.call_lead_es.toLowerCase()).toContain("bienes raices");
  });
});

describe("patchVoicemails", () => {
  const def = (): { steps: Array<Record<string, unknown>> } => ({
    steps: [
      { id: "parse", type: "extract_text", fields: [{ name: "lead_name" }] },
      { id: "call_lead_en", type: "place_ai_call", toVar: "lead_phone", personaTemplate: "Hi" },
      { id: "call_lead_es", type: "place_ai_call", toVar: "lead_phone", personaTemplate: "Hola" }
    ]
  });

  it("sets each rung's message and is a no-op on a second run", () => {
    const d = def();
    const res = patchVoicemails("New Lead Intake", d);
    expect(res.touched.sort()).toEqual(["call_lead_en", "call_lead_es"]);
    expect(d.steps[1]!.voicemailTemplate).toBe(NEW_LEAD_INTAKE_VOICEMAILS.call_lead_en);
    expect(patchVoicemails("New Lead Intake", d).changed).toBe(false);
  });

  // A renamed rung means the ladder moved and the rung-by-rung wording (which
  // says things like "our last message") may no longer describe the sequence.
  it("aborts rather than half-patching when a rung moved", () => {
    const d = def();
    d.steps[2].id = "call_lead_spanish";
    expect(() => patchVoicemails("New Lead Intake", d)).toThrow(/step "call_lead_es" is missing/);
  });

  it("refuses to put a voicemail on a step that places no call", () => {
    const d = def();
    d.steps[1].type = "send_sms";
    expect(() => patchVoicemails("New Lead Intake", d)).toThrow(/is a send_sms, not a call/);
  });

  it("refuses a flow it has no plan for", () => {
    expect(() => patchVoicemails("HomeLight Referral", { steps: [] })).toThrow(/no voicemail plan/);
  });
});
