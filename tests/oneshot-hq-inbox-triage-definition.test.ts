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
  GMAIL_LINK,
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
  cooldown?: { key?: string; minutes?: number };
  when?: { var?: string; equals?: string };
  fields?: { name?: string; description?: string }[];
  categories?: { value?: string; description?: string }[];
  addLabels?: string[];
  moveToFolder?: string;
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
const NOTIFY_IDS = ["s_notify_sales", "s_notify_support", "s_notify_billing"];

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

describe("HQ inbox triage: the subject comes from the trigger, never a model", () => {
  it("has no extracted subject field", () => {
    const extract = steps.find((s) => s.id === "s_extract");
    const names = (extract?.fields ?? []).map((f) => f.name);
    expect(names).not.toContain("email_subject");
  });

  it("templates the verbatim trigger subject in every alert", () => {
    expect(notifySteps).toHaveLength(3);
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
    expect(organize).toHaveLength(3);
    for (const step of organize) {
      expect(step.cooldown, step.id).toBeUndefined();
      expect(step.addLabels?.[0], step.id).toMatch(/^HQ\//);
    }
  });
});

describe("HQ inbox triage: the alert is actionable", () => {
  it("ends every alert with the Gmail deep link", () => {
    for (const step of notifySteps) {
      expect(step.message, step.id).toContain(GMAIL_LINK);
      expect(step.message?.trimEnd().endsWith(GMAIL_LINK), step.id).toBe(true);
    }
  });

  it("points the deep link at all mail, not the inbox", () => {
    // The email_organize steps move the message OUT of the inbox in the same
    // run, so an "#inbox/<id>" link would break on the mail it was minted for.
    expect(GMAIL_LINK).toContain("#all/");
    expect(GMAIL_LINK).toContain("{{trigger.message_id}}");
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
    const kinds = ["Sales", "Support", "Billing"];
    notifySteps.forEach((step, i) => {
      expect(step.message?.startsWith(`${kinds[i]} email from `), step.id).toBe(true);
      expect(step.message, step.id).toContain("{{trigger.from}}");
      expect(step.message, step.id).toContain("{{vars.email_sender}}");
    });
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

  const TRIGGER = {
    from: "james@kypads.com",
    subject: "Introductions",
    message_id: "199abc4d5e6f7890",
    thread_id: "199abc4d5e6f7890"
  };

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
        "Wants to introduce King to discuss automation for a clinic lead flow. " +
        "https://mail.google.com/mail/u/0/#all/199abc4d5e6f7890"
    );
  });

  it("leaves NO dangling separator when both extracted fields come back empty", () => {
    // This is the exact failure Brian saw. The old template rendered
    // "...from James@kypads.com: - James is introducing..." because an empty
    // subject collapsed and left its separator stranded. Whatever the model
    // returns, the text must still read as a sentence.
    const out = renderAlert("s_notify_sales", { email_sender: "", email_gist: "" }, TRIGGER);
    expect(out).toBe(
      "[AiFlow] Sales email from james@kypads.com. Subject: Introductions. " +
        "https://mail.google.com/mail/u/0/#all/199abc4d5e6f7890"
    );
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
        expect(out.endsWith(TRIGGER.message_id), label).toBe(true);
      }
    }
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
