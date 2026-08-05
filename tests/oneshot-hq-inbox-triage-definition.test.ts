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

const definition = buildHqInboxTriageDefinition() as { steps: StepJson[] };
const steps = definition.steps;
const notifySteps = steps.filter((s) => s.type === "notify_owner");
const NOTIFY_IDS = ["s_notify_sales", "s_notify_support", "s_notify_billing"];

describe("HQ inbox triage: the definition is valid and authorable", () => {
  it("passes the real authoring validator", () => {
    // Not a formality: this is what rejected {{trigger.subject}} as an
    // "unknown trigger field" before PR #1185 widened TRIGGER_SCOPE_KEYS, and
    // it is what caps the field/category description lengths.
    expect(() => parseAiFlowDefinition(buildHqInboxTriageDefinition())).not.toThrow();
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
