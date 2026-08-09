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
  archive?: boolean;
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
  it("feeds the recipient headers into the draft input", () => {
    const draft = steps.find((s) => s.id === "s_draft");
    expect(draft?.input).toContain("To: {{trigger.to}}");
    expect(draft?.input).toContain("Cc: {{trigger.cc}}");
    // And the sender, which decides who gets thanked.
    expect(draft?.input).toContain("From: {{trigger.from}}");
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
    expect(organize).toHaveLength(6);
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

  it("ARCHIVES the merely routine, so a misclassification costs nothing", () => {
    /**
     * The middle tier, and the reason it exists. On Aug 9 2026 an email titled
     * "[Action Needed] OAuth Verification Request Acknowledgement", on a thread
     * Brian had already replied to, was read as routine and went to the Bin.
     *
     * A classifier will always be wrong sometimes, so what matters is what a
     * wrong answer costs. Uncertain mail lands here and is merely out of the
     * inbox, still in All Mail.
     */
    const step = steps.find((s) => s.id === "s_org_automated");
    expect(step?.when).toEqual({ var: "email_kind", equals: "automated_notice" });
    expect(step?.markRead).toBe(true);
    expect(step?.archive).toBe(true);
    expect(step?.addLabels).toEqual(["HQ/Automated"]);
    // The whole point: this tier never destroys anything.
    expect(step?.trash).toBeUndefined();
    expect(notifySteps.some((n) => n.when?.equals === "automated_notice")).toBe(false);
  });

  it("bins ONLY the unmistakably bulk tier, and never texts about it", () => {
    const step = steps.find((s) => s.id === "s_org_bulk");
    expect(step?.when).toEqual({ var: "email_kind", equals: "automated_bulk" });
    expect(step?.markRead).toBe(true);
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

  it("texts about important automated mail and leaves it unread in the inbox", () => {
    const notify = steps.find((s) => s.id === "s_notify_automated");
    expect(notify?.type).toBe("notify_owner");
    expect(notify?.when).toEqual({ var: "email_kind", equals: "automated_important" });

    const organize = steps.find((s) => s.id === "s_org_automated_important");
    // Unread and in the inbox ON PURPOSE: the owner's own inbox has to keep
    // showing the thing that needs action, so this one is never archived.
    expect(organize?.markUnread).toBe(true);
    expect(organize?.archive).toBeUndefined();
    expect(organize?.markRead).toBeUndefined();
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

  it("drafts, asks, then replies inside the original thread", () => {
    expect(inArm("s_draft")).toMatchObject({ type: "run_agent", agentId: AGENT_ID });
    expect(inArm("s_gate")).toMatchObject({ type: "approval_gate" });
    // The reply threads against the row the trigger came from. Without this it
    // opens a new conversation beside the original, which is the whole
    // complaint about the dashboard Reply button.
    expect(inArm("s_send")).toMatchObject({
      type: "send_email",
      replyToEmailLogId: "{{trigger.email_log_id}}"
    });
  });

  it("lets Brian answer the gate with changes, and rewinds to the drafter", () => {
    // His actual reply shape is a pick PLUS a change, which a digit cannot
    // express. The rewind target must be the DRAFTING step or the redo is a
    // no-op.
    expect(inArm("s_gate")).toMatchObject({ allowModify: { redraftStepId: "s_draft" } });
  });

  it("feeds his words back into the redraft", () => {
    // The rewind only does something if the drafter reads what he said.
    expect(String(inArm("s_draft")?.input)).toContain("{{vars.approval_note}}");
  });

  it("still tells him when the drafter declines to answer", () => {
    // A real sales lead must never resolve to silence just because the model
    // had nothing to say. The gate and the send skip; the plain alert fires.
    expect(inArm("s_gate")).toMatchObject({ when: { notEquals: "NO_REPLY" } });
    expect(inArm("s_send")).toMatchObject({ when: { notEquals: "NO_REPLY" } });
    expect(inArm("s_notify_sales")).toMatchObject({ when: { equals: "NO_REPLY" } });
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
  it("cools the approval gate on the same thread key as the alerts", () => {
    // For a sales lead the GATE is what texts Brian, so it needs the
    // guarantee #1191 gave notify_owner. Without this, a second message on a
    // thread he is already deciding about would text him again, and the
    // regression would be invisible: the first text still looks right.
    const gate = steps.find((s) => s.id === "s_gate") as Record<string, unknown> | undefined;
    expect(gate?.cooldown).toEqual(THREAD_COOLDOWN);
  });

  it("leaves every owner-paging step in this flow cooled down", () => {
    // Whole-flow sweep rather than a per-step list, so a future step that
    // texts the owner cannot be added without a cooldown decision.
    const paging = steps.filter((s) => s.type === "notify_owner" || s.type === "approval_gate");
    expect(paging.length).toBeGreaterThanOrEqual(4);
    for (const step of paging) {
      expect((step as Record<string, unknown>).cooldown, step.id).toEqual(THREAD_COOLDOWN);
    }
  });
});

describe("HQ inbox triage: nothing sends without a human saying so", () => {
  it("puts the send DIRECTLY after the gate it is guarded by", () => {
    // approval_gate's skip semantics guard "the step directly after it", and
    // a cooling gate uses that same path. If anything were inserted between
    // the gate and the send, a skip or a cooldown would skip the WRONG step
    // and the draft would go out unapproved. Adjacency is load-bearing here,
    // so it is pinned rather than left to reading order.
    const arm = (
      definition.steps.find((s) => s.type === "branch") as {
        branches?: { id: string; steps: { id: string; type: string }[] }[];
      }
    ).branches?.find((b) => b.id === "b_sales");
    const ids = (arm?.steps ?? []).map((s) => s.id);
    expect(ids.indexOf("s_send")).toBe(ids.indexOf("s_gate") + 1);
  });

  it("has exactly one step that can send mail, and it sits behind the gate", () => {
    // A second send anywhere in the flow would not be covered by the gate,
    // and this is email to a stranger from Brian's own address.
    const sends = steps.filter((s) => s.type === "send_email");
    expect(sends.map((s) => s.id)).toEqual(["s_send"]);
  });
});
