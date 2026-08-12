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
   * The unclaimed read is its OWN step, and email_card keeps its gate.
   *
   * Dropping email_card's `when` is the obvious move and is wrong: the
   * late-retry ladder gates on `contact_status equals missing`, and that is
   * only a claim gate BECAUSE email_card never ran for unclaimed leads.
   * Ungating it walks unclaimed leads into late/late2, where every delivery
   * step addresses claimed_agent_phone and there is no claimer.
   */
  it("leaves email_card gated so the retry ladder keeps its shape", () => {
    const d = def();
    patchHomeLight(d);
    expect(d.steps.find((s) => s.id === "email_card")!.when).toEqual({
      var: "claimed_agent",
      notEquals: "none"
    });
  });

  it("adds a separate unclaimed read that copies email_card's matching", () => {
    const d = def();
    patchHomeLight(d);
    const read = d.steps.find((s) => s.id === "unclaimed_email_read")!;
    expect(read).toMatchObject({
      type: "email_extract",
      when: { var: "claimed_agent", equals: "none" },
      // Never overwrite what an earlier read already found.
      fillOnlyEmpty: true
    });
    const card = d.steps.find((s) => s.id === "email_card")!;
    expect(read.connectionId).toBe(card.connectionId);
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
  const tail = (d: { steps: Array<Record<string, unknown>> }) => {
    const branch = d.steps.find((s) => s.id === "late_unclaimed")! as Record<string, unknown>;
    return (branch.branches as Array<{ steps: Array<Record<string, unknown>> }>)[0].steps;
  };

  it("alerts the team when details arrive on a lead nobody claimed", () => {
    const d = def();
    patchHomeLight(d);
    const first = tail(d)[0]!;
    expect(first).toMatchObject({
      type: "notify_lead_owner",
      unownedFallback: "team",
      when: { var: "u1_status", equals: "found" }
    });
  });

  /**
   * DELIVERS AS SOON AS THE DETAILS LAND. Sleeping unconditionally before
   * testing made the team wait the full 75 minutes even when the FIRST read
   * already had the number. Every wait and re-read is gated on the previous
   * read still being "missing", so a found status skips the rest, exactly as
   * the claimed ladder behaves.
   */
  it("short-circuits once a read finds the details", () => {
    const d = def();
    patchHomeLight(d);
    const ids = tail(d).map((x) => x.id);
    expect(ids).toEqual([
      "late_unclaimed_alert",
      "unclaimed_wait_2",
      "unclaimed_email_read_2",
      "late_unclaimed_alert_2",
      "unclaimed_wait_3",
      "unclaimed_email_read_3",
      "late_unclaimed_alert_3"
    ]);
    for (const [id, prev] of [
      ["unclaimed_wait_2", "u1_status"],
      ["unclaimed_email_read_2", "u1_status"],
      ["unclaimed_wait_3", "u2_status"],
      ["unclaimed_email_read_3", "u2_status"]
    ]) {
      expect(tail(d).find((x) => x.id === id)!.when).toEqual({ var: prev, equals: "missing" });
    }
  });

  /**
   * A status var PER READ, mirroring contact_status / late_contact_status /
   * late2_contact_status on the claimed side. One shared status could not work:
   * the reads carry fillOnlyEmpty, so a status written "missing" on the first
   * pass could never be updated to "found" by a later one.
   */
  it("gives each read its own status var", () => {
    const d = def();
    patchHomeLight(d);
    const early = d.steps.find((s) => s.id === "unclaimed_email_read")!;
    expect((early.fields as Array<{ name: string }>).map((f) => f.name)).toContain("u1_status");
    for (const [id, v] of [["unclaimed_email_read_2", "u2_status"], ["unclaimed_email_read_3", "u3_status"]]) {
      const step = tail(d).find((x) => x.id === id)!;
      expect((step.fields as Array<{ name: string }>).map((f) => f.name)).toContain(v);
      expect(step.fillOnlyEmpty).toBe(true);
    }
  });

  it("re-reads the mailbox more than once, at widening delays", () => {
    const d = def();
    patchHomeLight(d);
    const waits = tail(d).filter((x) => x.type === "sleep");
    expect(waits.map((w) => w.minutes)).toEqual([15, 60]);
  });

  /**
   * Definitions cap TOP-LEVEL steps at 30 and this flow is near it, so the
   * whole tail lives in one branch. The validator rejected the flat version
   * before anything was written.
   */
  it("costs one top-level step, not seven", () => {
    const d = def();
    const before = d.steps.length;
    patchHomeLight(d);
    expect(d.steps.length).toBe(before + 2);
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
