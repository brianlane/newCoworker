/**
 * Regression pins for the HQ team-inbox triage flow
 * (scripts/oneshot/hq-inbox-triage-definition.ts).
 *
 * Every defect this flow shipped was a silent one. On Aug 5 2026 Brian got two
 * texts minutes apart about ONE Gmail thread:
 *
 *   [AiFlow] Sales email in the team inbox from James@kypads.com: - James is
 *   introducing Brian and King so Brian can discuss automation options ...
 *
 *   [AiFlow] Sales email in the team inbox from James@kypads.com:
 *   Re: Introductions - The sender is clarifying that James replied to the
 *   wrong person in the email thread.
 *
 * Four causes, none of which failed anything:
 *   1. the subject was AI-extracted from an unlabeled subject+body blob and
 *      came back "", leaving the bare separator at the front of text one;
 *   2. that separator was an em dash (rule 4), which gsmSafeSmsText rewrites
 *      to "-" on the way out, so the rule was broken in live copy invisibly;
 *   3. nothing knew both emails were one thread, so each got its own alert;
 *   4. the gist prompt invited narration ("The sender is clarifying...")
 *      instead of an ask.
 *
 * These assertions are the tripwire for all four.
 */
import { describe, expect, it } from "vitest";

import {
  FLOW_NAME,
  GMAIL_CONNECTION_ROW_ID,
  THREAD_COOLDOWN,
  buildHqInboxTriageDefinition
} from "../scripts/oneshot/hq-inbox-triage-definition";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { renderTemplate } from "../supabase/functions/_shared/ai_flows/engine";
import { prepareSmsBody } from "../supabase/functions/_shared/ai_flows/compliance";

type StepJson = {
  id?: string;
  type?: string;
  message?: string;
  /** run_agent: the rendered text handed to the saved agent instructions. */
  input?: string;
  cooldown?: { key?: string; minutes?: number };
  when?: { var?: string; equals?: string };
  fields?: { name?: string; description?: string }[];
  categories?: { value?: string; description?: string }[];
  addLabels?: string[];
  moveToFolder?: string;
  trash?: boolean;
  /** email_organize: the filing actions taken on the triggering message. */
  markRead?: boolean;
  markUnread?: boolean;
  /** email_organize: the display-only 1-10 importance score template. */
  importanceTemplate?: string;
  archive?: boolean;
  star?: boolean;
};

/** Any uuid: the applier supplies the real one after upserting the agent. */
const AGENT_ID = "3f7a1c90-1111-4111-8111-2c4e8b1f6a37";

const definition = buildHqInboxTriageDefinition(AGENT_ID) as { steps: StepJson[] };
/** The branch arms hold the real work now, so flatten before asserting. */
const steps: StepJson[] = definition.steps.flatMap((s) =>
  s.type === "branch"
    ? [s, ...((s as { branches?: { steps: StepJson[] }[] }).branches ?? []).flatMap((b) => b.steps)]
    : [s]
);
const notifySteps = steps.filter((s) => s.type === "notify_owner");
const NOTIFY_IDS = [
  "s_notify_sales",
  "s_notify_support",
  "s_notify_billing",
  "s_notify_automated"
];

describe("HQ inbox triage: the definition is valid and authorable", () => {
  it("passes the real authoring validator", () => {
    // Not a formality: this is what rejected {{trigger.subject}} as an
    // "unknown trigger field" before PR #1185 widened TRIGGER_SCOPE_KEYS, and
    // it is what caps the field/category description lengths.
    expect(() => parseAiFlowDefinition(buildHqInboxTriageDefinition(AGENT_ID))).not.toThrow();
  });

  it("stays out of the daily summary email", () => {
    // A mailbox poller's run count measures how much mail arrived, not how
    // much happened. On Aug 17 2026 this flow put 17 identical lines into a
    // 21-event daily summary and buried the day's one real call under them.
    // It texts Brian the moment anything here needs him, so its runs are the
    // one part of that email he could never act on.
    const def = buildHqInboxTriageDefinition(AGENT_ID) as { options?: { hideFromDigest?: boolean } };
    expect(def.options?.hideFromDigest).toBe(true);
    expect(parseAiFlowDefinition(def).options?.hideFromDigest).toBe(true);
  });

  it("keeps the upsert key and the watched mailbox", () => {
    // The applier finds the live row BY NAME, so a rename orphans the flow
    // and silently creates a second one.
    expect(FLOW_NAME).toBe("Team inbox triage (HQ)");
    expect(GMAIL_CONNECTION_ROW_ID).toBe("16cff2b9-b4d3-421c-b25d-b40edd80c9a8");
  });
});

describe("HQ inbox triage: the drafter is told who will receive the reply", () => {
  /**
   * Live, Aug 6 2026. James referred a client named Bobby without putting him
   * on the email, and the draft opened "Bobby, please reach out with any
   * questions", so the sentence written for the prospect reached only the
   * introducer. The drafter could not have known: the input carried From and
   * the body, never the recipient list.
   *
   * Both halves have to hold together, which is why they are asserted here
   * rather than at either end. The scope emitting `to`/`cc` buys nothing if
   * the step never templates them, and templating them throws at authoring
   * time if the keys are not allowlisted. That second half is not hypothetical:
   * {{trigger.message_ref}} shipped emitted-but-unreferenceable for exactly
   * this reason.
   */
  it("feeds the recipient headers into BOTH draft inputs", () => {
    for (const id of ["s_draft_prospect", "s_draft_intro"]) {
      const draft = steps.find((s) => s.id === id);
      expect(draft?.input, id).toContain("To: {{trigger.to}}");
      expect(draft?.input, id).toContain("Cc: {{trigger.cc}}");
      // And the sender, which decides who gets thanked.
      expect(draft?.input, id).toContain("From: {{trigger.from}}");
    }
  });

  it("accepts those refs through the real authoring validator", () => {
    // parseAiFlowDefinition is what rejects an unknown trigger field, so this
    // is the assertion that `to` and `cc` are in TRIGGER_SCOPE_KEYS.
    expect(() => parseAiFlowDefinition(buildHqInboxTriageDefinition(AGENT_ID))).not.toThrow();
  });
});

describe("HQ inbox triage: the subject comes from the trigger, never a model", () => {
  it("has no extracted subject field", () => {
    const extract = steps.find((s) => s.id === "s_extract");
    const names = (extract?.fields ?? []).map((f) => f.name);
    expect(names).not.toContain("email_subject");
  });

  it("templates the verbatim trigger subject in every alert", () => {
    // Sales, support, billing, and the automated mail that actually matters.
    expect(notifySteps).toHaveLength(4);
    for (const step of notifySteps) {
      expect(step.message, step.id).toContain("{{trigger.subject}}");
      expect(step.message, step.id).not.toContain("{{vars.email_subject}}");
    }
  });
});

describe("HQ inbox triage: one alert per conversation", () => {
  it("cools every alert down on the Gmail thread id", () => {
    for (const id of NOTIFY_IDS) {
      const step = steps.find((s) => s.id === id);
      expect(step?.cooldown, id).toEqual(THREAD_COOLDOWN);
      expect(step?.cooldown?.key, id).toBe("{{trigger.thread_id}}");
    }
  });

  it("uses a window long enough to cover a working day", () => {
    // Short enough that tomorrow's genuinely new reply still alerts.
    expect(THREAD_COOLDOWN.minutes).toBe(720);
    expect(THREAD_COOLDOWN.minutes).toBeLessThan(24 * 60);
  });

  it("files the mail whether or not the alert was suppressed", () => {
    // The cooldown silences notify_owner only. If filing ever became
    // conditional on the alert, a quiet reply would sit unlabeled forever.
    const organize = steps.filter((s) => s.type === "email_organize");
    expect(organize).toHaveLength(8);
    for (const step of organize) {
      expect(step.cooldown, step.id).toBeUndefined();
      expect(step.addLabels?.[0], step.id).toMatch(/^HQ\//);
    }
  });
});

describe("HQ inbox triage: the alert is actionable", () => {
  /**
   * NO LINK, deliberately, after trying two of them.
   *
   * The Gmail deep link opened Gmail on the WEB from a phone, so Brian had to
   * sign in and hunt for the message his own text had just summarized.
   * Swapping it for our own /dashboard/emails?id= only moved the login wall.
   * The text now carries what it takes to act (sender, subject, ask, and the
   * full draft) and approval is a digit reply, which needs no browser at all.
   * Re-adding a link should mean re-litigating that, not a quiet edit.
   */
  it("sends no link at all, in any alert or the approval gate", () => {
    for (const step of notifySteps) {
      expect(step.message, step.id).not.toMatch(/https?:\/\//);
    }
    const gate = steps.find((x) => x.id === "s_gate") as { prompt?: string } | undefined;
    expect(gate?.prompt).toBeDefined();
    expect(gate?.prompt).not.toMatch(/https?:\/\//);
  });

  it("never reaches for Gmail web or the dashboard again", () => {
    const json = JSON.stringify(definition);
    expect(json).not.toContain("mail.google.com");
    expect(json).not.toContain("/dashboard/emails");
  });

  it("asks the gist for an ask, and for silence when there is none", () => {
    const gist = steps
      .find((s) => s.id === "s_extract")
      ?.fields?.find((f) => f.name === "email_gist");
    // "The sender is clarifying that James replied to the wrong person" is a
    // true sentence and a useless alert.
    expect(gist?.description).toMatch(/start with the ask/i);
    expect(gist?.description).toMatch(/never with 'The sender'/i);
    expect(gist?.description).toMatch(/empty string/i);
  });

  it("requires a NEW ask before paging the owner as a sales lead", () => {
    const sales = steps
      .find((s) => s.id === "s_classify")
      ?.categories?.find((c) => c.value === "sales_lead");
    expect(sales?.description).toMatch(/NEW/);
    expect(sales?.description).toMatch(/thank-you|thread-correction/i);
  });

  it("labels each alert with its kind and names the sender", () => {
    // The first two words say what arrived, so the text is triageable from a
    // lock screen. "alert" rather than "email" on the automated one: that arm
    // only fires for mail with a real consequence if ignored.
    const openings: Record<string, string> = {
      s_notify_sales: "Sales email from ",
      s_notify_support: "Support email from ",
      s_notify_billing: "Billing email from ",
      s_notify_automated: "Automated alert from "
    };
    expect(notifySteps.map((s) => s.id).sort()).toEqual(Object.keys(openings).sort());
    for (const step of notifySteps) {
      expect(step.message?.startsWith(openings[step.id ?? ""]), step.id).toBe(true);
      expect(step.message, step.id).toContain("{{trigger.from}}");
      expect(step.message, step.id).toContain("{{vars.email_sender}}");
    }
  });
});

describe("HQ inbox triage: automated mail is split by consequence", () => {
  /**
   * Zapier and friends send mail with no working unsubscribe. It piled up
   * unread in the team inbox and every real message had to be picked out of
   * it. `automated_notice` was already a classify category, but NOTHING acted
   * on it: the run recognised the mail and then left it exactly where it was.
   *
   * The split is by consequence, not by sender. A Zapier outage notice and a
   * Zapier newsletter arrive from the same place and want opposite handling.
   */
  const category = (value: string) =>
    steps.find((s) => s.id === "s_classify")?.categories?.find((c) => c.value === value);

  it("offers both an important and a routine automated category", () => {
    expect(category("automated_important")?.description).toMatch(
      /outage|security|suspension|integration/i
    );
    expect(category("automated_notice")?.description).toMatch(/digest|receipt|calendar/i);
    // Judged by whether it asks anything of us, never by who sent it.
    expect(category("automated_notice")?.description).toMatch(/asks nothing of us/i);
    // The third tier: the only one that is ever destroyed.
    expect(category("automated_bulk")?.description).toMatch(/marketing|newsletter|promotion/i);
    // "Action needed" mail belongs in the tier that texts and keeps.
    expect(category("automated_important")?.description).toMatch(/verify|approve|respond/i);
  });

  it("only labels the merely routine, leaving it in the inbox", () => {
    /**
     * The middle tier, and the reason it exists. On Aug 9 2026 an email titled
     * "[Action Needed] OAuth Verification Request Acknowledgement", on a thread
     * Brian had already replied to, was read as routine and went to the Bin.
     *
     * It no longer archives either: mail disappearing from the inbox is the
     * complaint that started all of this, so an uncertain classification now
     * costs nothing at all.
     */
    const step = steps.find((s) => s.id === "s_org_automated");
    expect(step?.when).toEqual({ var: "email_kind", equals: "automated_notice" });
    expect(step?.addLabels).toEqual(["HQ/Automated"]);
    expect(step?.trash).toBeUndefined();
    expect(step?.archive).toBeUndefined();
    expect(notifySteps.some((n) => n.when?.equals === "automated_notice")).toBe(false);
  });

  it("gives platform outcomes their own silent tier", () => {
    /**
     * The Zoom miss, Aug 17 2026. "New Coworker OAuth has been updated and
     * published" classified `automated_notice` and was handled identically to
     * a Slack "Find and join channels" digest, because those were the only two
     * options: text him, or make it look like wallpaper.
     *
     * Silent is the whole point of the rung. A tier that texts is the tier
     * above it, and this one existing to NOT text is what makes the middle
     * case expressible at all.
     */
    const cat = (steps.find((s) => s.id === "s_classify")?.categories ?? []).find(
      (c) => c.value === "automated_review"
    );
    expect(cat?.description).toMatch(/app review|marketplace publication/i);
    expect(cat?.description).toMatch(/OAuth|verification/i);

    const step = steps.find((s) => s.id === "s_org_review");
    expect(step?.when).toEqual({ var: "email_kind", equals: "automated_review" });
    expect(step?.addLabels).toEqual(["HQ/Automated/Review"]);
    expect(step?.trash).toBeUndefined();
    expect(step?.archive).toBeUndefined();
    // Silent, and its own label rather than a star: every starred message in
    // this mailbox is a payment receipt and that signal stays single-meaning.
    expect(notifySteps.some((n) => n.when?.equals === "automated_review")).toBe(false);
    expect(step?.star).toBeUndefined();
  });

  it("keeps hosting renewals routine even with the review tier in play", () => {
    // The review tier is the nearest neighbour to this carve-out and the most
    // likely thing to swallow it: a renewal notice IS a platform telling us
    // about a service we run on. It must stay routine, because
    // src/lib/vps/billing-posture.ts owns fleet renewals and this classifier
    // cannot tell a box we are losing from one we chose to let lapse.
    const cat = (v: string) =>
      (steps.find((s) => s.id === "s_classify")?.categories ?? []).find((c) => c.value === v)
        ?.description ?? "";
    expect(cat("automated_notice")).toMatch(/hosting renewals/i);
    expect(cat("automated_review")).not.toMatch(/renewal/i);
  });

  it("keeps a platform outcome that still asks us something OUT of the review tier", () => {
    /**
     * The neighbour ABOVE the review tier, which the first wording missed.
     *
     * The Aug 18 2026 nightly caught "Your app submission needs changes /
     * Respond with an updated build to continue" classifying
     * `automated_review`, the SILENT tier, while the ChatGPT app and Meta App
     * Review were both in flight. The description named the platforms and
     * stopped, so it read as "any mail about a review" rather than "a review
     * that is over".
     *
     * The live boundary is pinned in tests/e2e/hq-inbox-classify.e2e.test.ts
     * against the real model. This is the deterministic half: the copy has to
     * SAY the outcome is finished, because a tier that texts and a tier that
     * is silent cannot be told apart by anything else here.
     */
    const cat = (v: string) =>
      (steps.find((s) => s.id === "s_classify")?.categories ?? []).find((c) => c.value === v)
        ?.description ?? "";
    expect(cat("automated_review")).toMatch(/done|finished|no reply|nothing further/i);
    // And the tier that DOES page still owns anything asking for a response.
    expect(cat("automated_important")).toMatch(/respond/i);
  });

  it("scores every filed message for the Emails page, and routes on none of it", () => {
    /**
     * The display-only 1-10 score. Every email_organize step carries it, so the
     * sort covers the whole mailbox rather than whichever tiers happened to get
     * the field.
     *
     * The second half is the load-bearing half: nothing may BRANCH on the
     * score. A model's number on an unanchored scale is steady enough to order
     * a list and not steady enough to decide whether to page someone, so the
     * routing stays on classify categories, which are prose a human can edit.
     */
    const organize = steps.filter((s) => s.type === "email_organize");
    expect(organize.length).toBeGreaterThan(0);
    for (const step of organize) {
      expect(step.importanceTemplate, step.id).toBe("{{vars.email_importance}}");
    }
    // The var it reads is really produced, and produced with anchors: an
    // unanchored 1-10 is where models cluster and drift.
    const field = (steps.find((s) => s.id === "s_extract")?.fields ?? []).find(
      (f) => f.name === "email_importance"
    );
    expect(field?.description).toMatch(/1-10/);
    expect(field?.description).toMatch(/digits only/i);

    // No gate, anywhere, reads the score.
    for (const step of steps) {
      expect(step.when?.var, step.id).not.toBe("email_importance");
    }
    const branch = definition.steps.find((s) => s.type === "branch") as
      | { branches?: { condition?: { var?: string } }[] }
      | undefined;
    for (const arm of branch?.branches ?? []) {
      expect(arm.condition?.var).not.toBe("email_importance");
    }
  });

  it("never marks a message read or unread, in any tier", () => {
    /**
     * Brian's rule, Aug 17 2026. Three steps used to set `markRead: true`, so
     * routine mail arrived already read: a Zoom Marketplace approval notice
     * and a Telnyx rate-change notice both landed that way the same morning,
     * and the read mark is what hid them.
     *
     * `markUnread` fails this too, deliberately. With nothing marking mail
     * read, forcing `automated_important` back to unread can only undo a human
     * who read it before the poll ran. Read state belongs to the reader.
     */
    for (const step of steps.filter((s) => s.type === "email_organize")) {
      expect(step.markRead, `${step.id} must not mark read`).toBeUndefined();
      expect(step.markUnread, `${step.id} must not mark unread`).toBeUndefined();
    }
  });

  it("keeps every send inside a branch, so the poller never marks mail read", () => {
    /**
     * The second read-marking path, and the one a future edit is most likely
     * to trip. `markGmailMessageHandled` (src/lib/ai-flows/email-poll.ts) marks
     * the TRIGGERING message read for any flow carrying an unconditional
     * `send_email` on the trunk, whatever the steps below say. Both of this
     * flow's sends live inside the `b_sales` arm behind a `when`, which is what
     * keeps the whole mailbox out of that path.
     */
    expect(definition.steps.filter((s) => s.type === "send_email")).toEqual([]);
    // And they do still exist, one arm down, so this stays a real constraint
    // rather than passing because the sends were deleted.
    expect(steps.filter((s) => s.type === "send_email").map((s) => s.id)).toEqual([
      "s_send_intro",
      "s_send_prospect"
    ]);
  });

  it("never removes anything from the inbox, by archive or by folder move", () => {
    // In Gmail a folder move strips the INBOX label, so it archives by another
    // name. Brian went looking for the Bobby referral on Aug 8 2026 and could
    // not find it: it was under HQ/Sales alone. Labels only now.
    for (const step of steps.filter((s) => s.type === "email_organize")) {
      expect(step.archive, step.id).toBeUndefined();
      expect(step.moveToFolder, step.id).toBeUndefined();
    }
  });

  it("stars billing receipts and leaves them where they are", () => {
    // Read off the live mailbox first: every starred message in HQ's Gmail is
    // a payment receipt or invoice, all left in the inbox.
    const step = steps.find((s) => s.id === "s_org_receipt");
    expect(step?.when).toEqual({ var: "email_kind", equals: "billing_receipt" });
    expect(step?.star).toBe(true);
    expect(step?.addLabels).toEqual(["HQ/Billing"]);
    expect(step?.trash).toBeUndefined();
    // A receipt needs no human, so it must not text.
    expect(notifySteps.some((n) => n.when?.equals === "billing_receipt")).toBe(false);
  });

  it("teaches every tier that an ongoing conversation is not routine", () => {
    // The wording-independent half of the OAuth fix. A phrase match cannot
    // reach a bland message; being in the thread can.
    const cat = (v: string) =>
      (steps.find((s) => s.id === "s_classify")?.categories ?? []).find((c) => c.value === v)
        ?.description ?? "";
    expect(cat("automated_important")).toMatch(/conversation we are in/i);
    expect(cat("automated_notice")).toMatch(/not part of a conversation/i);
    expect(cat("automated_bulk")).toMatch(/not already corresponding/i);
  });

  it("bins ONLY the unmistakably bulk tier, and never texts about it", () => {
    const step = steps.find((s) => s.id === "s_org_bulk");
    expect(step?.when).toEqual({ var: "email_kind", equals: "automated_bulk" });
    expect(step?.trash).toBe(true);
    // Labelled BEFORE binning, so a misclassification is still findable with
    // `label:HQ/Automated in:trash` for the 30 days Gmail keeps it.
    expect(step?.addLabels).toEqual(["HQ/Automated"]);
    expect(notifySteps.some((n) => n.when?.equals === "automated_bulk")).toBe(false);
  });

  it("keeps trash to exactly one step, so the blast radius stays visible", () => {
    const binning = steps.filter((s) => s.type === "email_organize" && s.trash === true);
    expect(binning.map((s) => s.id)).toEqual(["s_org_bulk"]);
  });

  it("texts about important automated mail and leaves it in the inbox", () => {
    const notify = steps.find((s) => s.id === "s_notify_automated");
    expect(notify?.type).toBe("notify_owner");
    expect(notify?.when).toEqual({ var: "email_kind", equals: "automated_important" });

    const organize = steps.find((s) => s.id === "s_org_automated_important");
    // In the inbox ON PURPOSE: the owner's own inbox has to keep showing the
    // thing that needs action, so this one is never archived. It used to
    // additionally force the message unread, which is now covered by the
    // blanket rule above (nothing in this flow touches read state at all).
    expect(organize?.archive).toBeUndefined();
    expect(organize?.addLabels).toEqual(["HQ/Automated"]);
  });
});

describe("HQ inbox triage: the text a phone actually receives", () => {
  /** Render like the worker does: collapseEmpty, then the outbound pipeline. */
  const renderAlert = (id: string, vars: Record<string, string>, trigger: Record<string, string>) =>
    prepareSmsBody(
      `[AiFlow] ${renderTemplate(
        steps.find((s) => s.id === id)?.message ?? "",
        { vars, trigger },
        { collapseEmpty: true }
      ).trim()}`
    );

  const EMAIL_LOG_ID = "7c1f2ab4-3d5e-4f60-9a81-2b3c4d5e6f70";
  const TRIGGER = {
    from: "james@kypads.com",
    subject: "Introductions",
    message_id: "199abc4d5e6f7890",
    thread_id: "199abc4d5e6f7890",
    email_log_id: EMAIL_LOG_ID
  };
  const DASH = `https://www.newcoworker.com/dashboard/emails?id=${EMAIL_LOG_ID}`;

  it("reads cleanly with everything populated", () => {
    expect(
      renderAlert(
        "s_notify_sales",
        {
          email_sender: "James (KYP Ads)",
          email_gist: "Wants to introduce King to discuss automation for a clinic lead flow."
        },
        TRIGGER
      )
    ).toBe(
      "[AiFlow] Sales email from james@kypads.com James (KYP Ads). Subject: Introductions. " +
        "Wants to introduce King to discuss automation for a clinic lead flow."
    );
  });

  it("leaves NO dangling separator when both extracted fields come back empty", () => {
    // This is the exact failure Brian saw. The old template rendered
    // "...from James@kypads.com: - James is introducing..." because an empty
    // subject collapsed and left its separator stranded. Whatever the model
    // returns, the text must still read as a sentence.
    const out = renderAlert("s_notify_sales", { email_sender: "", email_gist: "" }, TRIGGER);
    expect(out).toBe("[AiFlow] Sales email from james@kypads.com. Subject: Introductions.");
    expect(out).not.toMatch(/[.:]\s*[-.]\s/);
    expect(out).not.toMatch(/\s{2}/);
  });

  it("survives every combination of missing extracted fields", () => {
    for (const email_sender of ["", "James (KYP Ads)"]) {
      for (const email_gist of ["", "Wants pricing."]) {
        const out = renderAlert("s_notify_sales", { email_sender, email_gist }, TRIGGER);
        const label = JSON.stringify({ email_sender, email_gist });
        expect(out, label).not.toMatch(/\s{2}/); // no gap where a value was
        expect(out, label).not.toMatch(/[.:]\s*[-.]\s/); // no orphaned separator
        expect(out, label).not.toMatch(/https?:\/\//);
      }
    }
  });

  it("still ends as a clean sentence now that no link trails it", () => {
    // The link used to be the last token, so removing it exposed whatever
    // separator sat in front of it. A trailing space, period-space, or bare
    // hyphen is exactly the class of defect that started this whole thread.
    const out = renderAlert(
      "s_notify_sales",
      { email_sender: "James (KYP Ads)", email_gist: "Wants pricing." },
      TRIGGER
    );
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toBe(out.trimEnd());
    expect(out).toMatch(/[.!?]$/);
    expect(out).not.toMatch(/[.:]\s*[-.]\s*$/);
    expect(out).not.toMatch(/\s{2}/);
  });

  it("fits in one or two segments with a realistic payload", () => {
    // Operational SMS is metered per segment; an alert that routinely ran to
    // four parts would be a cost regression, not just an ugly one.
    const out = renderAlert(
      "s_notify_sales",
      {
        email_sender: "James (KYP Ads)",
        email_gist: "Wants a demo of the voice coworker for a 12-clinic group by Friday."
      },
      { ...TRIGGER, subject: "Re: Introductions and next steps for the clinic rollout" }
    );
    expect(out.length).toBeLessThanOrEqual(306); // 2 GSM segments
  });
});

describe("HQ inbox triage: writing rules hold in the shipped copy", () => {
  it("carries no em dash anywhere in the definition", () => {
    // The live text's bare "-" WAS an em dash: gsmSafeSmsText rewrites the
    // character on the way out, so the rule can be broken in shipped copy
    // without ever showing the character. Asserted on the whole serialized
    // definition, prompts included (rule 4 covers AI prompts too).
    expect(JSON.stringify(definition)).not.toContain("—");
  });

  it("never calls the product an AI receptionist", () => {
    expect(JSON.stringify(definition)).not.toMatch(/ai receptionist/i);
  });
});

describe("HQ inbox triage: a sales lead gets answered, not just announced", () => {
  const inArm = (id: string) => steps.find((s) => s.id === id) as Record<string, unknown> | undefined;

  it("drafts BOTH notes and sends them as two separate emails", () => {
    /**
     * Aug 9 2026. One reply-all thanking the introducer and pitching the
     * prospect reads oddly to both: each sees a paragraph written for the
     * other, and on a phone the recipient list is not even visible, so it
     * looks like a direct message that mentions a stranger.
     */
    expect(inArm("s_draft_prospect")).toMatchObject({ type: "run_agent", agentId: AGENT_ID });
    expect(inArm("s_draft_intro")).toMatchObject({ type: "run_agent", agentId: AGENT_ID });
    // Each note says which one it is, or the agent cannot tell them apart.
    expect(String(inArm("s_draft_prospect")?.input)).toContain("WRITE: PROSPECT");
    expect(String(inArm("s_draft_intro")?.input)).toContain("WRITE: INTRODUCER");
    // They save to different vars, or the second overwrites the first.
    expect(inArm("s_draft_prospect")?.saveAs).toBe("email_draft_prospect");
    expect(inArm("s_draft_intro")?.saveAs).toBe("email_draft_intro");

    // Both threaded, and NEITHER reply-all: mirroring would put both parties
    // back on both messages and undo the whole point of writing two.
    for (const id of ["s_send_intro", "s_send_prospect"]) {
      expect(inArm(id), id).toMatchObject({
        type: "send_email",
        replyToEmailLogId: "{{trigger.email_log_id}}",
        replyAll: false
      });
    }
  });

  it("addresses each note to its own person", () => {
    // The introducer is in From; the prospect is whoever is left after us and
    // the sender, which is exactly what others_to resolves to.
    expect(inArm("s_send_intro")?.to).toBe("{{trigger.from}}");
    expect(inArm("s_send_prospect")?.to).toBe("{{trigger.others_to}}");
    // Extra prospects ride on cc, since `to` takes a single address.
    expect(inArm("s_send_prospect")?.cc).toEqual(["{{trigger.others_cc}}"]);
    // And the two notes never cross: neither carries the other's body.
    expect(String(inArm("s_send_intro")?.body)).toBe("{{vars.email_draft_intro}}");
    expect(String(inArm("s_send_prospect")?.body)).toBe("{{vars.email_draft_prospect}}");
  });

  it("signs both emails with the branded platform signature", () => {
    /**
     * The real sign-off (logo, founder, phone) from branded-html.ts, composed
     * by the send path rather than written by the model: a signature is exact
     * by nature, and a model asked for one invents a title or a phone number.
     * I hand-wrote a replacement once and it was wrong on every line.
     */
    for (const id of ["s_send_intro", "s_send_prospect"]) {
      expect(inArm(id), id).toMatchObject({ brandedSignature: true });
      // Still plain text in the definition: the HTML part is built at send
      // time, so no markup ever sits in a flow template.
      expect(String(inArm(id)?.body), id).not.toMatch(/<[a-z]/i);
    }
  });

  it("shows Brian both notes, labelled with who gets each", () => {
    const prompt = String(inArm("s_gate")?.prompt);
    expect(prompt).toContain("{{vars.email_draft_intro}}");
    expect(prompt).toContain("{{vars.email_draft_prospect}}");
    // Labelled by recipient, or two blocks of text are indistinguishable.
    expect(prompt).toContain("To {{trigger.from}}:");
    expect(prompt).toContain("To {{trigger.others_to}}:");
  });

  it("lets Brian answer the gate with changes, and rewinds to the FIRST draft", () => {
    // His actual reply shape is a pick PLUS a change, which a digit cannot
    // express. The rewind must land on the first drafting step so BOTH notes
    // are rewritten: rewinding to the second would leave a stale prospect
    // note beside a freshly changed introducer note.
    expect(inArm("s_gate")).toMatchObject({
      allowModify: { redraftStepId: "s_draft_prospect" }
    });
    const ids = steps.map((x) => x.id);
    expect(ids.indexOf("s_draft_prospect")).toBeLessThan(ids.indexOf("s_draft_intro"));
  });

  it("feeds his words back into both redrafts", () => {
    // The rewind only does something if each drafter reads what he said.
    for (const id of ["s_draft_prospect", "s_draft_intro"]) {
      expect(String(inArm(id)?.input), id).toContain("{{vars.approval_note}}");
    }
  });

  it("still tells him when the drafter declines to answer", () => {
    // A real sales lead must never resolve to silence. Everything hangs off
    // the INTRODUCER note, because there is always a sender: the prospect
    // note is NO_REPLY whenever nobody else is on the mail, which is a normal
    // outcome rather than a decline.
    expect(inArm("s_gate")).toMatchObject({ when: { notEquals: "NO_REPLY" } });
    expect(inArm("s_send_intro")).toMatchObject({ when: { notEquals: "NO_REPLY" } });
    expect(inArm("s_notify_sales")).toMatchObject({ when: { equals: "NO_REPLY" } });
  });

  it("skips only the prospect note when there is no prospect", () => {
    // Two independent guards, because either alone leaves a hole: the drafter
    // returns NO_REPLY, and the send's templated `to` renders empty, which the
    // planner skips rather than failing the run.
    expect(inArm("s_send_prospect")).toMatchObject({
      when: { var: "email_draft_prospect", notEquals: "NO_REPLY" },
      to: "{{trigger.others_to}}"
    });
  });

  it("leaves support and billing on the alert-only path", () => {
    // Deliberate first rollout: only sales leads are answered automatically.
    for (const id of ["s_notify_support", "s_notify_billing"]) {
      expect(inArm(id), id).toMatchObject({ type: "notify_owner" });
    }
    expect(inArm("s_send_support")).toBeUndefined();
    expect(inArm("s_send_billing")).toBeUndefined();
  });
});

describe("HQ inbox triage: moving the paging did not lose the cooldown", () => {
  it("does NOT cool the approval gate, so every real follow-up still asks", () => {
    /**
     * A reversal, and the reason matters.
     *
     * The gate carried THREAD_COOLDOWN while it was an ALERT: a second message
     * on a conversation Brian had already been texted about stayed quiet
     * (#1191). It is now the APPROVAL, and since Aug 10 2026 the email
     * coworker no longer answers threads we have written on. A cooled gate
     * therefore means a genuine follow-up is classified, filed, and answered
     * by nobody: no reply, no text, silence.
     *
     * The #1191 duplicate is still covered by a better guard: a message with
     * no new ask makes the drafter return NO_REPLY, so no gate parks at all,
     * and the fallback alert keeps its cooldown so owner PAGING stays deduped.
     */
    const gate = steps.find((s) => s.id === "s_gate") as Record<string, unknown> | undefined;
    expect(gate?.cooldown).toBeUndefined();
    // The gate only exists when there IS a draft, which is what replaces it.
    expect(gate?.when).toEqual({ var: "email_draft_intro", notEquals: "NO_REPLY" });
    // And the alert that fires when there is no draft is still deduped.
    const notify = steps.find((s) => s.id === "s_notify_sales") as Record<string, unknown> | undefined;
    expect(notify?.cooldown).toEqual(THREAD_COOLDOWN);
  });

  it("leaves every owner-paging step in this flow cooled down", () => {
    // Whole-flow sweep rather than a per-step list, so a future step that
    // texts the owner cannot be added without a cooldown decision.
    // The approval gate is deliberately NOT cooled (see above): it is the
    // approval, not an alert, and cooling it silences a real follow-up.
    const paging = steps.filter((s) => s.type === "notify_owner");
    expect(paging.length).toBeGreaterThanOrEqual(4);
    for (const step of paging) {
      expect((step as Record<string, unknown>).cooldown, step.id).toEqual(THREAD_COOLDOWN);
    }
  });
});

describe("HQ inbox triage: nothing sends without a human saying so", () => {
  it("puts BOTH sends directly after the gate, and says the gate guards two", () => {
    /**
     * The gate's skip semantics guard "the steps directly after it", and a
     * cooling gate takes the same path. That advance defaulted to ONE step,
     * so a gate followed by two sends skipped the introducer note and mailed
     * the prospect anyway, with nobody having approved it.
     *
     * Adjacency AND the count are both load-bearing, so both are pinned: a
     * step inserted between them, or a third send added without bumping
     * guardsNextSteps, puts unapproved mail in front of a stranger.
     */
    const arm = (
      definition.steps.find((s) => s.type === "branch") as {
        branches?: { id: string; steps: { id: string; type: string }[] }[];
      }
    ).branches?.find((b) => b.id === "b_sales");
    const ids = (arm?.steps ?? []).map((s) => s.id);
    const gateAt = ids.indexOf("s_gate");
    expect(ids[gateAt + 1]).toBe("s_send_intro");
    expect(ids[gateAt + 2]).toBe("s_send_prospect");

    const gate = steps.find((x) => x.id === "s_gate") as { guardsNextSteps?: number } | undefined;
    expect(gate?.guardsNextSteps).toBe(2);
  });

  it("declares a guard count that matches the sends actually behind the gate", () => {
    // Derived rather than hard-coded, so adding a third send fails here
    // instead of silently escaping the approval.
    const arm = (
      definition.steps.find((s) => s.type === "branch") as {
        branches?: { id: string; steps: { id: string; type: string }[] }[];
      }
    ).branches?.find((b) => b.id === "b_sales");
    const armSteps = arm?.steps ?? [];
    const gateAt = armSteps.findIndex((s) => s.id === "s_gate");
    let sendsBehind = 0;
    for (let i = gateAt + 1; i < armSteps.length && armSteps[i].type === "send_email"; i += 1) {
      sendsBehind += 1;
    }
    const gate = steps.find((x) => x.id === "s_gate") as { guardsNextSteps?: number } | undefined;
    expect(gate?.guardsNextSteps ?? 1).toBe(sendsBehind);
  });

  it("has exactly one step that can send mail, and it sits behind the gate", () => {
    // A second send anywhere in the flow would not be covered by the gate,
    // and this is email to a stranger from Brian's own address.
    const sends = steps.filter((s) => s.type === "send_email");
    expect(sends.map((s) => s.id)).toEqual(["s_send_intro", "s_send_prospect"]);
    // Both sit behind the one gate, and the gate says it covers both.
    const gate = steps.find((x) => x.id === "s_gate") as { guardsNextSteps?: number } | undefined;
    expect(gate?.guardsNextSteps).toBe(sends.length);
  });
});
