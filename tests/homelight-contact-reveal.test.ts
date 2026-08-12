import { describe, expect, it } from "vitest";
import {
  ALREADY_CLAIMED_DESCRIPTION,
  EMAIL_FIELDS,
  addFields,
  patchHomeLight
} from "../scripts/oneshot/homelight-contact-reveal";

/**
 * Amy: "it broadcasts the lead to everyone but we never have the contact
 * information or the price." Four separate causes, found by reading Kevin
 * Duford's run (85d1bd1f) against the portal screenshot.
 */

const def = () => ({
  steps: [
    { id: "url", type: "extract_url", saveAs: "leadUrl" },
    { id: "alert", type: "extract_text", fields: [{ name: "lead_first_name" }, { name: "price" }] },
    {
      id: "open",
      type: "browse_extract",
      urlVar: "leadUrl",
      fields: [{ name: "already_claimed", description: "old wording" }]
    },
    { id: "route", type: "route_to_team", offerTemplate: "o", ownerFallbackTemplate: "f" },
    {
      id: "card",
      type: "browse_extract",
      urlVar: "leadUrl",
      fields: [{ name: "already_claimed", description: "old wording" }]
    },
    {
      id: "email_card",
      type: "email_extract",
      connectionId: "11111111-1111-4111-8111-111111111111",
      fields: [{ name: "lead_phone" }, { name: "contact_status" }],
      when: { var: "claimed_agent", notEquals: "none" }
    },
    { id: "to_agent", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: "yours" },
    { id: "qt_email", type: "send_email", to: "amy@amylaidlaw.com", subject: "QT", body: "claimed" },
    {
      id: "late_read",
      type: "email_extract",
      connectionId: "11111111-1111-4111-8111-111111111111",
      fields: [{ name: "lead_phone" }]
    },
    { id: "late_to_agent", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: "info" },
    {
      id: "late2_read",
      type: "email_extract",
      connectionId: "11111111-1111-4111-8111-111111111111",
      fields: [{ name: "lead_phone" }]
    },
    { id: "late2_to_agent", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: "info" },
    { id: "late2_never_agent", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: "nothing yet" },
    { id: "late2", type: "branch", branches: [{ id: "a", label: "a", condition: { var: "price", equals: "x" }, steps: [] }], else: [] }
  ]
});

describe("already_claimed", () => {
  /**
   * THE bug. The portal renders one flat "Claimed By: <name>" row whether the
   * claimer is this team or another agency, so asking about "another agent"
   * gave the model no way to tell them apart. On Kevin's run it answered "yes"
   * for OUR OWN claim and 39 of 61 steps were skipped.
   */
  it("teaches the question to recognise our own claim", () => {
    expect(ALREADY_CLAIMED_DESCRIPTION).toContain("Amy Laidlaw or her team");
    expect(ALREADY_CLAIMED_DESCRIPTION).toContain("OUR claim");
    expect(ALREADY_CLAIMED_DESCRIPTION.toLowerCase()).toContain("different brokerage");
  });

  // Extraction descriptions cap at 300; a longer one is rejected before write.
  it("fits the field description cap", () => {
    expect(ALREADY_CLAIMED_DESCRIPTION.length).toBeLessThanOrEqual(300);
    for (const f of EMAIL_FIELDS) expect(f.description.length).toBeLessThanOrEqual(300);
  });

  /**
   * Names the TEAM, not four individuals. A roster list in a prompt goes stale
   * the moment somebody joins, which is the account's standing rule about
   * hardcoded teammate names.
   */
  it("does not hardcode the whole roster", () => {
    for (const n of ["Dave Lane", "Gabrielle Mota", "Jason Lane"]) {
      expect(ALREADY_CLAIMED_DESCRIPTION).not.toContain(n);
    }
  });

  it("rewrites it on both the pre-claim and post-claim reads", () => {
    const d = def();
    const res = patchHomeLight(d);
    expect(res.touched).toContain("open.already_claimed");
    expect(res.touched).toContain("card.already_claimed");
  });
});

describe("reading the email", () => {
  /**
   * Backwards before this: the details sat in Amy's inbox and nothing fetched
   * them unless someone had ALREADY claimed. The team needs the details in
   * order to decide whether to claim.
   */
  it("reads the email even when nobody has claimed", () => {
    const d = def();
    patchHomeLight(d);
    expect(d.steps.find((s) => s.id === "email_card")).not.toHaveProperty("when");
  });

  it("pulls price and timeframe from the email on all three reads", () => {
    const d = def();
    patchHomeLight(d);
    for (const id of ["email_card", "late_read", "late2_read"]) {
      const names = (d.steps.find((s) => s.id === id)!.fields as Array<{ name: string }>).map(
        (f) => f.name
      );
      expect(names).toContain("email_price");
      expect(names).toContain("email_timeframe");
      expect(names).toContain("email_summary");
    }
  });

  // The alert says "$560K"; the email says "$560,000". The exact figure is
  // what a teammate wants before calling.
  it("asks for the exact figure, not the rounded one", () => {
    expect(EMAIL_FIELDS.find((f) => f.name === "email_price")!.description).toContain("not the rounded");
  });
});

describe("who hears the revealed details", () => {
  it("puts price and timeframe in every contact-info text", () => {
    const d = def();
    patchHomeLight(d);
    for (const id of ["to_agent", "late_to_agent", "late2_to_agent"]) {
      expect(String(d.steps.find((s) => s.id === id)!.body)).toContain("{{vars.email_price}}");
    }
  });

  /**
   * Every contact-info text addressed claimed_agent_phone, so on an UNCLAIMED
   * lead the details arrived and went to nobody. notify_lead_owner resolves
   * the owner at run time and falls back to the team when there is none.
   */
  it("alerts the team when details arrive on a lead nobody claimed", () => {
    const d = def();
    patchHomeLight(d);
    const alert = d.steps.find((s) => s.id === "late_unclaimed_alert")!;
    expect(alert).toMatchObject({
      type: "notify_lead_owner",
      unownedFallback: "team",
      when: { var: "claimed_agent", equals: "none" }
    });
  });

  // Amy's own copy carries the whole client-details block: the "screenshot the
  // entire email" ask, in the form the engine can actually deliver.
  it("gives Amy the full client-details block", () => {
    const d = def();
    patchHomeLight(d);
    expect(String(d.steps.find((s) => s.id === "qt_email")!.body)).toContain("{{vars.email_summary}}");
  });

  /**
   * HomeLight reveals details ONLY after a successful transfer or connected
   * call, so when a seller hangs up first, none are coming. "Still waiting"
   * would leave the claimer expecting something that never arrives.
   */
  it("says why nothing is coming when the transfer never connected", () => {
    const d = def();
    patchHomeLight(d);
    expect(String(d.steps.find((s) => s.id === "late2_never_agent")!.body)).toContain(
      "only releases contact details"
    );
  });
});

describe("safety", () => {
  it("is a no-op on a second run", () => {
    const d = def();
    patchHomeLight(d);
    expect(patchHomeLight(d).changed).toBe(false);
  });

  it("aborts rather than half-patching when a step moved", () => {
    const d = def();
    d.steps = d.steps.filter((s) => s.id !== "email_card");
    expect(() => patchHomeLight(d)).toThrow(/step "email_card" is missing/);
  });

  it("aborts when the claim field it rewrites is gone", () => {
    const d = def();
    (d.steps[2] as { fields: Array<{ name: string }> }).fields = [{ name: "something_else" }];
    expect(() => patchHomeLight(d)).toThrow(/no already_claimed field/);
  });
});

describe("addFields", () => {
  it("adds only what is missing and reports no change when complete", () => {
    const step = { id: "x", fields: [{ name: "email_price", description: "d" }] };
    expect(addFields(step, EMAIL_FIELDS)).toBe(true);
    expect(step.fields).toHaveLength(3);
    expect(addFields(step, EMAIL_FIELDS)).toBe(false);
  });
});
