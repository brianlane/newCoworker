/**
 * The pure half of scripts/oneshot/heal-inquiry-spelling.ts: the rewrite rule
 * that healed the live AiFlow definitions and parked run vars still spelling
 * "inquiry" the British way (Amy Laidlaw, 2026-08-28).
 *
 * The IO shell is deliberately untested here (it needs a live PostgREST);
 * what matters is that the substitution cannot corrupt the JSON it walks or
 * miss a case variant, because it runs against ENABLED tenant automations.
 */
import { describe, expect, it } from "vitest";
import {
  OPEN_RUN_STATUSES,
  hasBannedSpelling,
  healJsonSpelling,
  toAmericanInquirySpelling
} from "../scripts/oneshot/heal-inquiry-spelling";

describe("toAmericanInquirySpelling", () => {
  it("rewrites the exact phrases the live flows were speaking", () => {
    // Amy's cadence persona and its unknown-site fallback, verbatim from
    // ai_flows 9c1dbf7f on the day of the fix.
    expect(
      toAmericanInquirySpelling("We're following up on your enquiry through Clever")
    ).toBe("We're following up on your inquiry through Clever");
    expect(toAmericanInquirySpelling("your recent enquiry")).toBe("your recent inquiry");
    // The ReferralExchange flow's team context template.
    expect(toAmericanInquirySpelling("They enquired through listwithclever.com")).toBe(
      "They inquired through listwithclever.com"
    );
  });

  it("covers the whole word family, not just the noun", () => {
    expect(toAmericanInquirySpelling("enquiry enquiries enquire enquired enquiring")).toBe(
      "inquiry inquiries inquire inquired inquiring"
    );
  });

  it("preserves casing instead of flattening it", () => {
    expect(toAmericanInquirySpelling("Enquiry")).toBe("Inquiry");
    expect(toAmericanInquirySpelling("ENQUIRIES")).toBe("INQUIRIES");
    expect(toAmericanInquirySpelling("enquiry")).toBe("inquiry");
    // Mid-sentence capital, e.g. an SMS body starting a clause.
    expect(toAmericanInquirySpelling("New Enquiry. Reply 1 to claim.")).toBe(
      "New Inquiry. Reply 1 to claim."
    );
  });

  it("leaves everything else alone, including the word it rewrites TO", () => {
    for (const untouched of [
      "",
      "your inquiry through Clever",
      "inquiries",
      // Not the target family: the substring is "quir", not "enquir".
      "require enquiry-free acquiring",
      "{{vars.lead_site_ref}}"
    ]) {
      expect(toAmericanInquirySpelling(untouched)).toBe(
        untouched.replace("enquiry", "inquiry")
      );
    }
    // Idempotent: healed text is a fixed point.
    const once = toAmericanInquirySpelling("your enquiry through Clever");
    expect(toAmericanInquirySpelling(once)).toBe(once);
  });
});

describe("hasBannedSpelling", () => {
  it("finds the spelling at any depth, and reports clean values as clean", () => {
    expect(hasBannedSpelling({ steps: [{ personaTemplate: "your enquiry" }] })).toBe(true);
    expect(hasBannedSpelling({ vars: { lead_site_ref: "your Enquiry through Clever" } })).toBe(
      true
    );
    expect(hasBannedSpelling({ steps: [{ personaTemplate: "your inquiry" }] })).toBe(false);
    expect(hasBannedSpelling(null)).toBe(false);
    expect(hasBannedSpelling(undefined)).toBe(false);
  });
});

describe("healJsonSpelling", () => {
  it("rewrites nested strings and counts each one that moved", () => {
    // Shaped like a real flow definition: the persona, the voicemail script,
    // and the extraction-field instruction all carried it.
    const definition = {
      steps: [
        {
          id: "r1_call",
          personaTemplate: "We're following up on {{vars.lead_site_ref}}",
          voicemailTemplate: "following up on your enquiry through Clever"
        },
        {
          id: "extract",
          fields: [
            { name: "lead_site_ref", description: "the words 'your enquiry through'" }
          ]
        }
      ],
      options: { enabled: true, rounds: 4 }
    };
    const { healed, changed } = healJsonSpelling(definition);
    expect(changed).toBe(2);
    expect(healed.steps[0].voicemailTemplate).toBe(
      "following up on your inquiry through Clever"
    );
    expect(healed.steps[1].fields?.[0].description).toBe("the words 'your inquiry through'");
    // Structure, ids, and non-string values survive byte for byte.
    expect(healed.steps[0].id).toBe("r1_call");
    expect(healed.steps[0].personaTemplate).toBe("We're following up on {{vars.lead_site_ref}}");
    expect(healed.options).toEqual({ enabled: true, rounds: 4 });
    // The input is not mutated: a failed write must leave the caller's copy
    // of the live definition intact.
    expect(definition.steps[0].voicemailTemplate).toBe(
      "following up on your enquiry through Clever"
    );
  });

  it("handles every JSON node type it can meet", () => {
    const { healed, changed } = healJsonSpelling({
      arr: ["your enquiry", 42, null, true, ["nested enquiry"]],
      nothing: null,
      num: 7,
      bool: false
    });
    expect(changed).toBe(2);
    expect(healed.arr).toEqual(["your inquiry", 42, null, true, ["nested inquiry"]]);
    expect(healed.nothing).toBeNull();
    expect(healed.num).toBe(7);
    expect(healed.bool).toBe(false);
  });

  it("reports zero changes for an already-healed value, so a re-run is a no-op", () => {
    const clean = { vars: { lead_site_ref: "your inquiry through Clever" } };
    const { healed, changed } = healJsonSpelling(clean);
    expect(changed).toBe(0);
    expect(healed).toEqual(clean);
  });

  it("leaves object KEYS alone: other stored copy references them by name", () => {
    // No live key carries the spelling, but a rewrite here would silently
    // break a "{{vars.<name>}}" reference elsewhere in the same definition.
    const { healed, changed } = healJsonSpelling({ enquiry_count: "your enquiry" });
    expect(changed).toBe(1);
    expect(Object.keys(healed)).toEqual(["enquiry_count"]);
    expect(healed.enquiry_count).toBe("your inquiry");
  });
});

describe("the run statuses it will touch", () => {
  it("is limited to runs that still have something to say", () => {
    // A done or canceled run's context is the record of what was actually
    // sent; rewriting it would edit history rather than fix future copy.
    expect([...OPEN_RUN_STATUSES]).toEqual(["awaiting_reply", "queued"]);
  });
});
