import { describe, expect, it } from "vitest";
import {
  buildClassifyPrompt,
  parseClassifyChoice
} from "../../supabase/functions/_shared/ai_flows/engine";
import { buildHqInboxTriageDefinition } from "../../scripts/oneshot/hq-inbox-triage-definition";
import { geminiJson } from "./gemini";

/**
 * The HQ team-inbox classifier, against the LIVE model, using the REAL
 * category descriptions the one-shot seeds.
 *
 * The definition test next door can only prove the descriptions SAY the right
 * thing. Whether the model then routes a real email the right way is a
 * different question, and it is the one that has actually bitten: every
 * misrouted alert in this flow's history read fine in the source.
 *
 * Each case below is an email that really arrived.
 */

/** Pulled from the real definition, so drift in either shows up here. */
const AGENT_ID = "3f7a1c90-1111-4111-8111-2c4e8b1f6a37";
const definition = buildHqInboxTriageDefinition(AGENT_ID) as {
  steps: { id?: string; question?: string; categories?: { value: string; description?: string }[] }[];
};
const classifyStep = definition.steps.find((s) => s.id === "s_classify");
const CATEGORIES = classifyStep?.categories ?? [];
const QUESTION = classifyStep?.question;

async function classify(text: string): Promise<string> {
  const raw = await geminiJson(buildClassifyPrompt(CATEGORIES, text, QUESTION));
  return parseClassifyChoice(raw, CATEGORIES);
}

/** The flow renders the mail into windowText as subject + body. */
const email = (subject: string, body: string) => `${subject}\n${body}`;

describe("HQ inbox classify: the categories are wired to the live flow", () => {
  it("reads its categories from the real definition, not a local copy", () => {
    expect(CATEGORIES.map((c) => c.value).sort()).toEqual([
      "automated_important",
      "automated_notice",
      "billing",
      "sales_lead",
      "support"
    ]);
  });
});

describe("HQ inbox classify: hosting renewals never page the owner", () => {
  /**
   * Live, Aug 6 2026, 10:22pm. Hostinger mailed that the KVM 2 plan on
   * srv1800985 had expired, and the flow texted Brian a billing alert about
   * it. That box was the RETIRED residency pilot
   * (scripts/oneshot/retire-residency-pilot.ts): lapsing was the plan.
   *
   * The classifier cannot tell a box we are about to lose from one we chose to
   * let go, so every such alert is a coin flip. src/lib/vps/billing-posture.ts
   * can: it runs on cron, auto-heals auto-renew for boxes a paying tenant
   * depends on, and honours a `never_renew` flag for boxes that must lapse by
   * design. It owns this, so the flow stays quiet.
   */
  const HOSTINGER_EXPIRED = email(
    "Your KVM 2 plan has expired",
    [
      "Hi there,",
      "",
      "Your KVM 2 plan for srv1800985.hstgr.cloud has expired.",
      "",
      "Renew now for 24.49 USD for 1 month to keep your server and its data.",
      "",
      "The Hostinger team"
    ].join("\n")
  );

  it(
    "files an expired hosting plan as routine, not billing",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(HOSTINGER_EXPIRED);
      // Not billing (that texts), not automated_important (that texts too).
      expect(kind).toBe("automated_notice");
    }
  );

  it(
    "files a hosting renewal reminder as routine too",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email(
          "Your plan renews in 7 days",
          "Your KVM 2 plan for srv1806097.hstgr.cloud renews on Aug 14 for 24.49 USD."
        )
      );
      expect(kind).toBe("automated_notice");
    }
  );
});

describe("HQ inbox classify: a real money problem still pages", () => {
  /**
   * The guard above must not swallow billing that genuinely needs a human. No
   * cron owns a declined card or a dispute, so these stay `billing`.
   */
  it(
    "a declined payment is still billing",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email(
          "Your payment was declined",
          [
            "We could not charge the card ending 4242 for your Telnyx account.",
            "Service may be interrupted if payment is not updated."
          ].join("\n")
        )
      );
      expect(kind).toBe("billing");
    }
  );

  it(
    "a chargeback is still billing",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email(
          "A customer opened a dispute",
          "A cardholder disputed a 149.00 USD charge. Respond by Aug 20 or the funds are withdrawn."
        )
      );
      expect(kind).toBe("billing");
    }
  );

  it(
    "a receipt for a successful charge stays routine",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email("Your receipt from Stripe", "Thanks for your payment of 20.00 USD. Nothing is due.")
      );
      expect(kind).toBe("automated_notice");
    }
  );
});

describe("HQ inbox classify: automated mail that must not be archived", () => {
  it(
    "a live outage is automated_important",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email(
          "Incident: elevated API error rates",
          "We are investigating elevated 5xx error rates affecting message delivery. Updates to follow."
        )
      );
      expect(kind).toBe("automated_important");
    }
  );

  it(
    "a security alert is automated_important",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email(
          "New sign-in from an unrecognized device",
          "Someone signed in to your account from a new device in Frankfurt, Germany."
        )
      );
      expect(kind).toBe("automated_important");
    }
  );

  it(
    "a Zapier marketing blast is routine",
    { retry: 1, timeout: 120_000 },
    async () => {
      // The mail with no working unsubscribe that started this.
      const kind = await classify(
        email(
          "See what is new in Zapier this month",
          "New AI actions, a faster editor, and 12 new integrations. Explore the release notes."
        )
      );
      expect(kind).toBe("automated_notice");
    }
  );
});
