/**
 * Regression pins for Scar Fairy's canonical flow definition and knowledge
 * documents (scripts/oneshot/scar-fairy-lead-definition.ts and
 * scar-fairy-knowledge-content.ts), the builders that
 * patch-scar-fairy-lead-flow.ts and patch-scar-fairy-knowledge.ts re-apply to
 * the live tenant.
 *
 * The load-bearing pin is the position of `s_goal`. The owner's requirement is
 * "give the lead a few minutes to book, and if they book, do not text them".
 * That works only because a booking goal event fast-forwards a `queued` run to
 * the first matching goal step AHEAD of its position, skipping everything in
 * between (goal_events.ts, JUMPABLE_STATUSES). If `s_goal` ever moves above the
 * sends, a lead who books inside the window gets the text and the email anyway,
 * silently. Nothing else in the system catches that, so it is pinned here.
 *
 * The other pins guard defects that were live on this account before the patch:
 * an unscoped webhook trigger that fired on any event, and copy containing em
 * dashes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildScarFairyLeadDefinition,
  bookingLinkIsPending,
  SCAR_FAIRY_BOOKING_LINK,
  SCAR_FAIRY_BOOKING_LINK_PENDING,
  SCAR_FAIRY_PACKAGES,
  SCAR_FAIRY_QUIET_HOURS,
  SCAR_FAIRY_SELF_BOOK_MINUTES
} from "../scripts/oneshot/scar-fairy-lead-definition";
import {
  buildScarFairyIdentityMd,
  buildScarFairySoulMd,
  replaceMarkdownSection,
  SCAR_FAIRY_BUNDLES
} from "../scripts/oneshot/scar-fairy-knowledge-content";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { smsQuietDecision, zonedClock } from "../supabase/functions/_shared/ai_flows/quiet_hours";

type StepJson = {
  id?: string;
  type?: string;
  body?: string;
  minutes?: number;
  when?: { var?: string; notEquals?: string };
  events?: Array<{ kind?: string }>;
  quietHours?: { timezone?: string; noSendAfter?: string; resumeAt?: string };
  steps?: StepJson[];
  branches?: Array<{ id?: string; steps?: StepJson[] }>;
  else?: StepJson[];
};

/** Every step in the definition, branch arms and else included. */
function allSteps(definition: Record<string, unknown>): StepJson[] {
  const out: StepJson[] = [];
  const walk = (steps: StepJson[] | undefined) => {
    for (const s of steps ?? []) {
      out.push(s);
      for (const arm of s.branches ?? []) walk(arm.steps);
      walk(s.else);
    }
  };
  walk((definition as { steps?: StepJson[] }).steps);
  return out;
}

function trunkSteps(definition: Record<string, unknown>): StepJson[] {
  return (definition as { steps?: StepJson[] }).steps ?? [];
}

/** The literal expected gate, kept independent of the exported constant so a
 * typo'd export can never make the assertions pass vacuously. */
const EXPECTED_QUIET_HOURS = {
  timezone: "America/New_York",
  noSendAfter: "20:00",
  resumeAt: "09:00"
};

const LINK = "https://example.test/book";

describe("Scar Fairy lead definition", () => {
  const definition = buildScarFairyLeadDefinition(LINK);
  const trunk = trunkSteps(definition);
  const steps = allSteps(definition);

  it("validates as a well-formed AiFlow definition", () => {
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("scopes the webhook trigger to Meta leads", () => {
    // The row this replaces carried `conditions: []`, which fired the whole
    // nurture on ANY authenticated webhook event, not just Meta lead forms.
    expect(definition.trigger).toEqual({
      channel: "webhook",
      conditions: [{ type: "from_matches", value: "facebook_lead_ads" }]
    });
  });

  describe("the self-book window", () => {
    it("waits exactly 3 minutes, before the branch that sends anything", () => {
      const sleepIdx = trunk.findIndex((s) => s.type === "sleep");
      const branchIdx = trunk.findIndex((s) => s.type === "branch");
      expect(sleepIdx).toBeGreaterThan(-1);
      expect(trunk[sleepIdx].minutes).toBe(3);
      expect(SCAR_FAIRY_SELF_BOOK_MINUTES).toBe(3);
      expect(sleepIdx).toBeLessThan(branchIdx);
    });

    it("notifies the owner BEFORE the sleep, so a new lead is never delayed", () => {
      const notifyIdx = trunk.findIndex((s) => s.id === "s_notify_new");
      const sleepIdx = trunk.findIndex((s) => s.type === "sleep");
      expect(notifyIdx).toBeGreaterThan(-1);
      expect(notifyIdx).toBeLessThan(sleepIdx);
    });

    it("puts the goal LAST so a booking mid-window skips every send", () => {
      // This is the whole mechanism. See the file header.
      const last = trunk[trunk.length - 1];
      expect(last.id).toBe("s_goal");
      expect(last.type).toBe("goal");
      expect(last.events?.map((e) => e.kind)).toContain("appointment_booked");
    });

    it("has no send step after the goal", () => {
      const goalIdx = trunk.findIndex((s) => s.type === "goal");
      const after = trunk.slice(goalIdx + 1);
      expect(after.filter((s) => s.type === "send_sms" || s.type === "send_email")).toEqual([]);
    });
  });

  describe("bundle routing", () => {
    const branch = trunk.find((s) => s.type === "branch");

    it("has one arm per bundle plus a general else arm", () => {
      expect(branch?.branches).toHaveLength(3);
      expect(branch?.branches?.map((a) => a.id)).toEqual([
        "arm_melasma",
        "arm_vajacial",
        "arm_acne"
      ]);
      expect(branch?.else?.length).toBeGreaterThan(0);
    });

    it("sends both a text and an email on every arm, including the else arm", () => {
      const arms = [...(branch?.branches?.map((a) => a.steps ?? []) ?? []), branch?.else ?? []];
      expect(arms).toHaveLength(4);
      for (const arm of arms) {
        expect(arm.filter((s) => s.type === "send_sms")).toHaveLength(1);
        expect(arm.filter((s) => s.type === "send_email")).toHaveLength(1);
      }
    });

    it("quotes each bundle's own price and no other bundle's price", () => {
      // A misroute here quotes a wrong price to a real customer, which is why
      // the routing is a deterministic branch rather than a classify step.
      for (const pkg of SCAR_FAIRY_PACKAGES) {
        const arm = branch?.branches?.find((a) => a.id === `arm_${pkg.prefix}`);
        const sms = arm?.steps?.find((s) => s.type === "send_sms");
        expect(sms?.body, `${pkg.prefix} arm must quote ${pkg.price}`).toContain(pkg.price);
        for (const other of SCAR_FAIRY_PACKAGES) {
          if (other.price === pkg.price) continue;
          expect(sms?.body, `${pkg.prefix} arm must not quote ${other.price}`).not.toContain(
            other.price
          );
        }
      }
    });

    it("guards every email on the lead actually having one", () => {
      // Meta lead forms do not guarantee an email; send_email fails on empty `to`.
      for (const email of steps.filter((s) => s.type === "send_email")) {
        expect(email.when, `${email.id} is missing its lead_email guard`).toEqual({
          var: "lead_email",
          notEquals: "none"
        });
      }
    });
  });

  describe("quiet hours", () => {
    it("exports the canonical 09:00-20:00 America/New_York gate", () => {
      expect(SCAR_FAIRY_QUIET_HOURS).toEqual(EXPECTED_QUIET_HOURS);
    });

    it("gates every lead-facing SMS", () => {
      const smsSteps = steps.filter((s) => s.type === "send_sms");
      expect(smsSteps.length).toBeGreaterThan(0);
      for (const sms of smsSteps) {
        expect(sms.quietHours, `${sms.id} is missing quietHours`).toEqual(EXPECTED_QUIET_HOURS);
      }
    });

    it("refuses a 2:12 AM New York send and resumes at 09:00", () => {
      // 2:12 AM EDT (UTC-4) = 06:12 UTC.
      const nightMs = Date.parse("2026-08-03T06:12:00Z");
      const decision = smsQuietDecision(nightMs, EXPECTED_QUIET_HOURS);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(zonedClock(decision.resumeAtMs, "America/New_York")?.minutesOfDay).toBe(9 * 60);
        expect(decision.resumeAtMs).toBeGreaterThan(nightMs);
      }
    });

    it("allows a 2 PM New York send", () => {
      expect(smsQuietDecision(Date.parse("2026-08-03T18:00:00Z"), EXPECTED_QUIET_HOURS)).toEqual({
        allowed: true
      });
    });
  });

  describe("the pending booking link", () => {
    it("still ships as a placeholder, so the applier refuses to write", () => {
      // Flip this test when Selena's real Vagaro link lands: the constant
      // changes and bookingLinkIsPending() goes false.
      expect(SCAR_FAIRY_BOOKING_LINK).toBe(SCAR_FAIRY_BOOKING_LINK_PENDING);
      expect(bookingLinkIsPending()).toBe(true);
    });

    it("reports a real link as not pending", () => {
      expect(bookingLinkIsPending(LINK)).toBe(false);
    });

    it("blocks --apply but never the dry run", () => {
      // The applier's CLI body cannot be imported (top-level await plus a live
      // Supabase client), so this pins the ordering in source. It shipped the
      // wrong way round once: the placeholder guard sat above the --apply
      // check, so the documented dry run exited 1 and nobody could read the
      // diff while the link was still pending, which is precisely when they
      // need to. Caught in review on PR #1038.
      const src = readFileSync(
        new URL("../scripts/oneshot/patch-scar-fairy-lead-flow.ts", import.meta.url),
        "utf8"
      );
      const dryRunExit = src.indexOf("dry run complete");
      const applyRefusal = src.indexOf("REFUSING TO APPLY");
      expect(dryRunExit).toBeGreaterThan(-1);
      expect(applyRefusal).toBeGreaterThan(-1);
      expect(applyRefusal).toBeGreaterThan(dryRunExit);
    });
  });

  it("contains no em dashes", () => {
    expect(JSON.stringify(definition)).not.toContain("—");
  });
});

describe("Scar Fairy knowledge content", () => {
  it("puts every bundle price in identity.md", () => {
    // identity_md is a knowledge-graph source at trust 3, the tier that a
    // lead's claim can never supersede. This is why pricing lives here.
    const identity = buildScarFairyIdentityMd();
    for (const bundle of SCAR_FAIRY_BUNDLES) {
      expect(identity).toContain(bundle.name);
      expect(identity).toContain(bundle.price);
    }
  });

  it("names the skin concerns the coworker could not previously answer on", () => {
    const identity = buildScarFairyIdentityMd();
    for (const concern of ["Melasma", "Hyperpigmentation", "Acne", "Rosacea", "Stretch marks"]) {
      expect(identity).toContain(concern);
    }
  });

  it("keeps the flow definition and identity.md quoting the same prices", () => {
    // Two documents, one set of prices. They drift silently otherwise: the
    // flow texts one number while the coworker answers with another.
    expect(SCAR_FAIRY_BUNDLES.map((b) => b.price).sort()).toEqual(
      SCAR_FAIRY_PACKAGES.map((p) => p.price).sort()
    );
  });

  describe("soul.md repair", () => {
    const BROKEN_SOUL = [
      "# soul.md",
      "",
      "## Communication Style",
      "- Warm and empathetic",
      "",
      "## Response Goals",
      "- Are the results permanent?",
      "- Can the laser be used on all skin types?",
      "",
      "## Signature",
      "Use the business's preferred sign-off when one is provided.",
      "",
      "<!-- white-glove-build:start -->",
      "## White-glove build (from the signed build document)",
      '- Every new lead gets this greeting within 60 seconds: "Hi name.  Thanks for contacting us."',
      "  1. Are mornings or afternoons or mornings or afternoons better for you?",
      "- Quoting prices or discounts",
      "<!-- white-glove-build:end -->",
      ""
    ].join("\n");

    const repaired = buildScarFairySoulMd(BROKEN_SOUL);

    it("replaces the FAQ questions onboarding put under Response Goals", () => {
      expect(repaired).not.toContain("- Are the results permanent?");
      expect(repaired).not.toContain("- Can the laser be used on all skin types?");
      expect(repaired).toContain("Understand which skin or body concern");
    });

    it("removes the placeholder greeting and the duplicated question", () => {
      expect(repaired).not.toContain("Hi name.");
      expect(repaired).not.toContain("or mornings or afternoons");
    });

    it("resolves the price-quoting contradiction with the lead flow", () => {
      // The old block said hand off on "Quoting prices or discounts" while the
      // flow texts a bundle price. The repair approves exactly three prices.
      expect(repaired).toContain("### Prices you may quote");
      for (const bundle of SCAR_FAIRY_BUNDLES) {
        expect(repaired).toContain(`${bundle.name}: ${bundle.price}`);
      }
      expect(repaired).toContain("Custom or discounted pricing");
    });

    it("preserves owner-authored sections outside the repaired regions", () => {
      expect(repaired).toContain("## Communication Style");
      expect(repaired).toContain("- Warm and empathetic");
      expect(repaired).toContain("Use the business's preferred sign-off when one is provided.");
    });

    it("is idempotent, so a re-run converges instead of stacking", () => {
      expect(buildScarFairySoulMd(repaired)).toBe(repaired);
      expect(buildScarFairySoulMd(buildScarFairySoulMd(repaired))).toBe(repaired);
    });

    it("contains no em dashes", () => {
      expect(repaired).not.toContain("—");
      expect(buildScarFairyIdentityMd()).not.toContain("—");
    });
  });

  describe("replaceMarkdownSection", () => {
    const doc = ["# t", "", "## A", "old", "", "## B", "keep", ""].join("\n");

    it("replaces only the named section's body", () => {
      const out = replaceMarkdownSection(doc, "A", "new");
      expect(out).toContain("## A\nnew");
      expect(out).not.toContain("old");
      expect(out).toContain("## B\nkeep");
    });

    it("leaves the document alone when the heading is absent", () => {
      // A hand-edited document that dropped the section must not gain an
      // append; a no-op is the safe outcome.
      expect(replaceMarkdownSection(doc, "Missing", "new")).toBe(doc);
    });
  });
});
