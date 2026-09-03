import { describe, expect, it } from "vitest";
import {
  claimBlockedByOwner,
  claimGateSkipsRun,
  flowDealsInLeadPhone,
  ownerConflictReplyText,
  ownershipLeadPhone
} from "../supabase/functions/_shared/ai_flows/claim_owner_gate";

/**
 * The contact-ownership claim gate (claim_owner_gate.ts). The scenario the
 * policy exists for: Austin Happ arrived as a seller and a buyer lead two
 * seconds apart (2026-08-08); Dave claimed the seller in 53 seconds and
 * Gabrielle claimed the buyer 28 minutes later, splitting one contact
 * across two teammates.
 */

const DAVE = "+16025245719";
const GABBY = "+14807202013";

describe("claimBlockedByOwner", () => {
  it("blocks a different teammate once an active owner exists", () => {
    expect(
      claimBlockedByOwner({ phone: DAVE, name: "Dave Lane", active: true }, GABBY)
    ).toBe(true);
  });

  it("always lets the owner claim their own contact's leads", () => {
    expect(claimBlockedByOwner({ phone: DAVE, name: "Dave Lane", active: true }, DAVE)).toBe(
      false
    );
  });

  it("never blocks on an unowned contact", () => {
    expect(claimBlockedByOwner(null, GABBY)).toBe(false);
  });

  it("an ex-teammate's ownership never blocks", () => {
    expect(
      claimBlockedByOwner({ phone: DAVE, name: "Dave Lane", active: false }, GABBY)
    ).toBe(false);
  });

  it("a phoneless owner row never blocks (nothing to route to anyway)", () => {
    expect(claimBlockedByOwner({ phone: "", name: "Dave Lane", active: true }, GABBY)).toBe(
      false
    );
  });
});

describe("ownerConflictReplyText", () => {
  it("names the lead and the owner, and asks nothing of the sender", () => {
    const t = ownerConflictReplyText("Dave Lane", "Austin Happ");
    expect(t).toContain("Austin Happ is already with Dave Lane");
    expect(t).toContain("they own this contact");
    expect(t).not.toContain("from an earlier lead");
    expect(t).toContain("Nothing needed from you");
  });

  it("falls back gracefully when the names are blank", () => {
    const t = ownerConflictReplyText("  ", "");
    expect(t).toContain("This lead is already with another teammate");
  });

  it("contains no em dash", () => {
    expect(ownerConflictReplyText("Dave Lane", "Austin Happ").includes("\u2014")).toBe(false);
  });
});

describe("claimGateSkipsRun", () => {
  it("skips the ownership gate on an owner-direct park (an ack, never a claim)", () => {
    expect(claimGateSkipsRun({ owner_direct: true })).toBe(true);
  });

  it("does not skip a real teammate offer", () => {
    expect(claimGateSkipsRun({})).toBe(false);
    expect(claimGateSkipsRun({ owner_direct: false })).toBe(false);
    expect(claimGateSkipsRun(null)).toBe(false);
    expect(claimGateSkipsRun(undefined)).toBe(false);
  });
});

describe("ownershipLeadPhone", () => {
  /**
   * Danfar (HomeLight, 2026-08-10): the flow extracts lead_phone but
   * HomeLight withholds it pre-claim, so the value is "". The old sender
   * fallback bound ownership to HomeLight's own alert line, made Dave its
   * "owner" at Friday's claim, and the next referral skipped the team race.
   */
  it("an extracted-but-empty lead phone means UNKNOWN, never the sender", () => {
    expect(ownershipLeadPhone(true, null, "+14159157879")).toBeNull();
  });

  it("a real extracted phone always wins", () => {
    expect(ownershipLeadPhone(true, "+14802715202", "+14159157879")).toBe("+14802715202");
    expect(ownershipLeadPhone(false, "+14802715202", "+14159157879")).toBe("+14802715202");
  });

  it("a flow that never deals in lead_phone may treat the sender as the lead", () => {
    // The customer-texts-in case, where that is literally true.
    expect(ownershipLeadPhone(false, null, "+14165550100")).toBe("+14165550100");
    expect(ownershipLeadPhone(false, null, null)).toBeNull();
  });
});

/**
 * Amy C. (HomeLight, 2026-08-14). The Danfar guard above asked a RUNTIME
 * question: does `vars.lead_phone` exist yet? On the HomeLight flow,
 * route_to_team is step 5 and the extraction that declares lead_phone is
 * step 6, so at route time the key does NOT exist and the sender fallback
 * fired anyway. Ownership bound to HomeLight's own alert line
 * (+1 415-915-7879), whose contact row a July claim had already stamped
 * with an owner, and every referral from Aug 11 to Aug 14 was
 * owner-assigned to one teammate with no team race.
 *
 * The fix reads the FLOW DEFINITION instead of the variable bag: whether a
 * flow deals in lead phone numbers is fixed before step 0, so it answers
 * the same at step 5 as it does at step 6.
 */
describe("flowDealsInLeadPhone", () => {
  it("is true when a step EXTRACTS lead_phone, even though no step has run", () => {
    // The exact HomeLight ordering: routing first, extraction second.
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "route", type: "route_to_team", offerTemplate: "New lead." },
        {
          id: "card",
          type: "browse_extract",
          fields: [{ name: "lead_phone", description: "The lead's mobile." }]
        }
      ]
    };
    expect(flowDealsInLeadPhone(def)).toBe(true);
  });

  it("is true for a template mention, a when-condition, and a saveAs", () => {
    expect(
      flowDealsInLeadPhone({ steps: [{ id: "s", type: "send_sms", toTemplate: "{{vars.lead_phone}}" }] })
    ).toBe(true);
    expect(
      flowDealsInLeadPhone({ steps: [{ id: "s", type: "sleep", when: { var: "lead_phone", equals: "" } }] })
    ).toBe(true);
    expect(flowDealsInLeadPhone({ steps: [{ id: "s", type: "math", saveAs: "lead_phone" }] })).toBe(
      true
    );
  });

  it("finds a declaration nested inside branch steps", () => {
    const def = {
      steps: [
        {
          id: "late",
          type: "branch",
          branches: [
            {
              id: "still_ours",
              steps: [
                {
                  id: "deep",
                  type: "email_extract",
                  fields: [{ name: "lead_phone", description: "from the release email" }]
                }
              ]
            }
          ]
        }
      ]
    };
    expect(flowDealsInLeadPhone(def)).toBe(true);
  });

  it("is false for a flow that never mentions a lead phone at all", () => {
    // The customer-texts-in case: the sender genuinely IS the contact, and
    // the ownership fallback must keep working for them.
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "reply", type: "send_sms", bodyTemplate: "Thanks {{vars.lead_first_name}}." },
        { id: "route", type: "route_to_team", offerTemplate: "New lead." }
      ]
    };
    expect(flowDealsInLeadPhone(def)).toBe(false);
  });

  it("is false for a missing or non-object definition, never throwing", () => {
    expect(flowDealsInLeadPhone(null)).toBe(false);
    expect(flowDealsInLeadPhone(undefined)).toBe(false);
    expect(flowDealsInLeadPhone("lead_phone")).toBe(false);
    expect(flowDealsInLeadPhone(42)).toBe(false);
    expect(flowDealsInLeadPhone({})).toBe(false);
  });

  it("matches the identifier as an object KEY, not just as a value", () => {
    // Config shapes carry var names on either side. HomeLight's own
    // wait_for_call writes its backfill as [{ to: "lead_phone" }], a value,
    // but a map-shaped variant puts the same name in key position, and a
    // scan that only reads values would call that flow phone-free.
    expect(flowDealsInLeadPhone({ steps: [{ id: "s", backfill: { lead_phone: "phone" } }] })).toBe(
      true
    );
  });

  it("counts a lead_phone-prefixed var too: dealing in one is dealing in all", () => {
    // Conservative on purpose. A flow handling lead_phone_2 is a relay flow
    // whatever it calls the field, and the cost of a false positive is one
    // extra team race, versus a lead silently assigned to the wrong agent.
    expect(
      flowDealsInLeadPhone({ steps: [{ id: "s", type: "extract_text", fields: [{ name: "lead_phone_2" }] }] })
    ).toBe(true);
  });

  it("drives the gate: a relay flow at step 0 refuses the sender", () => {
    // The regression in one line. Nothing extracted yet (null), sender is
    // the partner alert line, and ownership must resolve to nothing.
    const relay = { steps: [{ id: "c", type: "browse_extract", fields: [{ name: "lead_phone" }] }] };
    expect(ownershipLeadPhone(flowDealsInLeadPhone(relay), null, "+14159157879")).toBeNull();
  });
});
