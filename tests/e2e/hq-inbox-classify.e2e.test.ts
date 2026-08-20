import { describe, expect, it } from "vitest";
import {
  buildClassifyPrompt,
  parseClassifyChoice
} from "../../supabase/functions/_shared/ai_flows/engine";
import { buildHqInboxTriageDefinition } from "../../scripts/oneshot/hq-inbox-triage-definition";
import { emailTriggerScope } from "@/lib/ai-flows/trigger-eval";
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
      "automated_bulk",
      "automated_important",
      "automated_notice",
      "automated_review",
      "billing",
      "billing_receipt",
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
      // Routine, not bulk: it is a real service notice, so it is archived
      // rather than binned even though it needs no action.
      expect(kind).toBe("automated_notice");
    }
  );

  /**
   * Live, Aug 20 2026, 2:02pm: the SAME failure the case above was written to
   * stop, in wording the case above does not cover, so it never caught it.
   *
   * The fixture above says "has expired" and asks for nothing. The real mail
   * says the plan "has been canceled as we have not received payment", and it
   * asks twice: a "View restore options" button and "if you consider this to
   * be a mistake, please reply to this email". That wording matches `billing`
   * ("a failed or declined payment") head-on and disqualifies itself from the
   * old `automated_notice` wording ("asks nothing of us"), so it paged Brian
   * about srv1632631, a box flagged never_renew in July so it WOULD lapse.
   *
   * The old wording was replayed against five framings of this one email
   * (run e04e2550, five draws each). It was not merely wrong, it was
   * UNSTABLE, and the framing decided the answer:
   *
   *   production windowText verbatim  -> billing 5/5             (texts)
   *   this condensed fixture          -> automated_important 5/5 (texts)
   *   same, tracking URLs redacted    -> automated_notice 5/5    (silent)
   *
   * The 1.5KB of opaque per-recipient tracking tokens were load-bearing:
   * removing them alone flipped the verdict. The new wording answers
   * automated_notice on all five framings, 25 draws, which is the actual
   * repair. A category that only wins when the sender formats the mail a
   * certain way is not a category.
   *
   * This fixture is the condensed shape rather than the verbatim one, because
   * reproducing `billing` needs those tracking tokens and they are tied to
   * Brian's address. It is still a real guard: it answered a PAGING tier 5/5
   * before the fix, so it fails loudly if the wording regresses.
   */
  it(
    "files a plan canceled for non-payment as routine, restore button and all",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        email("Your KVM 8 srv1632631.hstgr.cloud has been canceled", [
          "Your KVM 8 for srv1632631.hstgr.cloud has been canceled as we have",
          "not received payment for the renewal.",
          "",
          "Check your VPS service list to see if you can restore your plan and",
          "keep your data.",
          "",
          "If you consider this to be a mistake, please reply to this email.",
          "",
          "View restore options"
        ].join("\n"))
      );
      // Not billing and not automated_important: both of those text him, and
      // billing-posture.ts is what actually knows this box was meant to die.
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
      // Its own tier now: a record worth keeping, and Brian stars these by
      // hand, so the flow does too.
      expect(kind).toBe("billing_receipt");
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
    "a Zapier marketing blast is bulk, the only tier that gets binned",
    { retry: 1, timeout: 120_000 },
    async () => {
      // The mail with no working unsubscribe that started this.
      const kind = await classify(
        email(
          "See what is new in Zapier this month",
          "New AI actions, a faster editor, and 12 new integrations. Explore the release notes."
        )
      );
      expect(kind).toBe("automated_bulk");
    }
  );
});

describe("HQ inbox classify: mail that asks us to act is never binned", () => {
  /**
   * Live, Aug 9 2026. This exact email was classified routine and went to the
   * Bin: Google acknowledging our OAuth verification request, on a thread
   * Brian had already replied to on Jul 30. Two signals ignored at once, the
   * literal words "Action Needed" and an ongoing correspondence.
   *
   * The three-tier split is the structural half of the fix (an uncertain
   * classification now archives rather than destroys). These cases are the
   * other half: mail asking us to do something is important, full stop.
   */
  const OAUTH_ACK = email(
    "[Action Needed] OAuth Verification Request Acknowledgement",
    [
      "Hello,",
      "",
      "We have received your OAuth verification request for New Coworker.",
      "",
      "To continue, please confirm your domain ownership and reply with the",
      "requested scope justifications. Your request cannot proceed until we",
      "hear back from you.",
      "",
      "The API OAuth Developer Verification team"
    ].join("\n")
  );

  it("reads the OAuth verification acknowledgement as important", { retry: 1, timeout: 120_000 }, async () => {
    expect(await classify(OAUTH_ACK)).toBe("automated_important");
  });

  it("reads a plain verification request as important", { retry: 1, timeout: 120_000 }, async () => {
    const kind = await classify(
      email(
        "Action required: verify your domain",
        "Please verify ownership of newcoworker.com within 7 days to keep sending."
      )
    );
    expect(kind).toBe("automated_important");
  });

  /**
   * The boundary between the two automated tiers that both talk about
   * platform reviews, pinned from BOTH sides because it has now moved twice.
   *
   * `automated_review` (added Aug 17 2026, PR #1433) is SILENT: labelled
   * HQ/Automated/Review and nothing else. `automated_important` TEXTS. The
   * first wording of the review tier named the platforms and stopped there,
   * so the nightly on Aug 18 2026 caught it swallowing this rejection: a
   * submission that needs changes is a review outcome AND an ask, and it went
   * quiet at the exact moment two submissions were in flight (the ChatGPT app
   * and Meta App Review).
   *
   * The rule the descriptions now carry: a platform outcome that is finished
   * and wants nothing is `automated_review`; one that still wants something
   * from us is `automated_important`, whatever it is about.
   */
  it("reads an app-review REJECTION as important, because it asks us to act", { retry: 1, timeout: 120_000 }, async () => {
    const kind = await classify(
      email(
        "Your app submission needs changes",
        "Reviewers found issues with your integration. Respond with an updated build to continue."
      )
    );
    expect(kind).toBe("automated_important");
  });

  it("keeps a FINISHED app review in the silent review tier", { retry: 1, timeout: 120_000 }, async () => {
    // The other side of the same line. Fixing the rejection must not drag the
    // whole tier back into texting, which is the state PR #1433 got us out of.
    const kind = await classify(
      email(
        "Your app has been approved",
        "Your submission passed review and is now live for all users. Nothing further is required."
      )
    );
    expect(kind).toBe("automated_review");
  });

  it("keeps the Zoom publication notice in the silent review tier", { retry: 1, timeout: 120_000 }, async () => {
    // The live Aug 17 2026 mail the tier was built for. It has no Gmail thread
    // history at all (submitted through the Zoom Marketplace portal), so the
    // category description is the only thing that can place it.
    const kind = await classify(
      email(
        "New Coworker OAuth has been updated and published",
        "Your app's OAuth update has been reviewed and is now published on the Zoom App Marketplace. No further action is needed."
      )
    );
    expect(kind).toBe("automated_review");
  });

  it("still bins mail that genuinely asks nothing", { retry: 1, timeout: 120_000 }, async () => {
    // The guard must not turn every automated mail into a text.
    const kind = await classify(
      email(
        "New in Zapier this month",
        "New AI actions, a faster editor, and 12 new integrations. Explore the release notes."
      )
    );
    expect(kind).toBe("automated_bulk");
  });

  it("keeps the merely routine in the middle tier", { retry: 1, timeout: 120_000 }, async () => {
    // Nothing to do, but not junk and not a receipt: read and labelled, left
    // in the inbox. Nothing in this flow archives any more.
    const kind = await classify(
      email(
        "Your weekly usage summary",
        "Here are your numbers for the week. No action is required."
      )
    );
    expect(kind).toBe("automated_notice");
  });
});

describe("HQ inbox classify: a conversation we are already in is never routine", () => {
  /**
   * The thread signal, end to end through the REAL trigger scope.
   *
   * The classifier reads windowText, and `emailTriggerScope` appends the
   * marker to it when the poller found one of our own sends on the thread.
   * That is the whole mechanism, so the test builds the scope rather than
   * hand-writing the marker: if the scope stopped appending it, hand-writing
   * it here would keep passing while production went back to binning.
   */
  const scoped = (subject: string, body: string, replied: boolean) =>
    String(
      emailTriggerScope({
        id: "m1",
        fromEmail: "api-oauth-dev-verification@google.com",
        subject,
        bodyText: body,
        threadId: "t-1",
        weRepliedOnThread: replied
      }).windowText
    );

  // Deliberately bland: a status note that means nothing on its own. If the
  // body were self-evidently urgent the control below would also come back
  // important, and the pair would be measuring the wording, not the marker.
  const BLAND_BODY = [
    "Here is a summary of recent activity on your developer account.",
    "No further information is included in this message."
  ].join("\n");

  it(
    "escalates a bland notice once we are in the conversation",
    { retry: 1, timeout: 120_000 },
    async () => {
      // No "Action Needed", nothing urgent in the body: the ONLY thing
      // separating this from the control below is the thread marker. This is
      // the case a phrase-matching rule can never reach.
      const kind = await classify(scoped("Developer account update", BLAND_BODY, true));
      expect(kind).toBe("automated_important");
    }
  );

  it(
    "leaves the same message routine when we have never replied",
    { retry: 1, timeout: 120_000 },
    async () => {
      // The control. If this also came back important the marker would be
      // proving nothing, and the test above would be measuring the wording.
      const kind = await classify(scoped("Developer account update", BLAND_BODY, false));
      expect(kind).not.toBe("automated_important");
    }
  );

  it(
    "will not bin a newsletter-shaped message on a live conversation",
    { retry: 1, timeout: 120_000 },
    async () => {
      const kind = await classify(
        scoped("Re: your integration review", "Following up on the thread below.", true)
      );
      expect(kind).not.toBe("automated_bulk");
    }
  );
});

describe("HQ inbox classify: receipts are their own tier", () => {
  /**
   * Every starred message in HQ's live Gmail is a payment receipt or invoice,
   * so these are the real senders, read off the mailbox.
   */
  const RECEIPTS: Array<[string, string]> = [
    ["Your receipt from Anthropic, PBC #2711-1769", "Thanks for your payment. Amount 200.00 USD."],
    ["Your receipt from Vercel Inc. #2593-7121", "Payment received for your Pro plan."],
    ["[Telnyx LLC] Payment Success", "Your payment of 100.00 USD was processed successfully."],
    ["Payment received for Supabase Pte. Ltd. invoice", "We received your payment. No action needed."]
  ];
  for (const [subject, body] of RECEIPTS) {
    it(`files "${subject.slice(0, 30)}" as a receipt`, { retry: 1, timeout: 120_000 }, async () => {
      expect(await classify(email(subject, body))).toBe("billing_receipt");
    });
  }

  it("does NOT swallow a real bill we still owe", { retry: 1, timeout: 120_000 }, async () => {
    // The tier must not become a bucket for anything money-shaped.
    const kind = await classify(
      email("Invoice 4021 due in 3 days", "Amount due 480.00 USD. Please pay by Friday to avoid interruption.")
    );
    expect(kind).toBe("billing");
  });
});
