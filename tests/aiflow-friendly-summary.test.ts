/**
 * Owner-facing flow summaries (src/components/dashboard/aiflow-labels.ts).
 *
 * The dashboard used to describe the Prospecting flow as "When a webhook event
 * matches 1 condition(s)", which is precise, correct, and no help at all to the
 * person whose business it is. These assertions are about readability, so they
 * check for the absence of jargon as much as the presence of wording.
 *
 * `summarizeDefinition` in the schema is deliberately NOT changed: debug CLIs
 * and other tests read it, and there the technical phrasing is right.
 */
import { describe, expect, it } from "vitest";

import { friendlyFlowSummary, friendlyTriggerLabel } from "@/components/dashboard/aiflow-labels";
import { prospectOutreachTemplate } from "@/lib/ai-flows/templates";
import { summarizeDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

function def(trigger: unknown, steps: unknown[] = []): AiFlowDefinition {
  return { version: 1, trigger, steps } as AiFlowDefinition;
}

const CONTAINS = { type: "contains", value: "quote" };

describe("friendlyTriggerLabel", () => {
  it("says when a flow runs without naming a mechanism", () => {
    expect(friendlyTriggerLabel(def({ channel: "sms", conditions: [] }))).toBe(
      "When anyone texts you"
    );
    expect(friendlyTriggerLabel(def({ channel: "manual" }))).toBe("When you ask for it");
    expect(friendlyTriggerLabel(def({ channel: "email", conditions: [] }))).toBe(
      "When any email arrives"
    );
    expect(friendlyTriggerLabel(def({ channel: "tenant_email", conditions: [] }))).toBe(
      "When your coworker's mailbox gets an email"
    );
    expect(friendlyTriggerLabel(def({ channel: "webhook", conditions: [] }))).toBe(
      "When another system sends something in"
    );
    expect(friendlyTriggerLabel(def({ channel: "contact_created", conditions: [] }))).toBe(
      "When a new contact is added"
    );
  });

  it("counts rules in English, singular and plural", () => {
    expect(friendlyTriggerLabel(def({ channel: "sms", conditions: [CONTAINS] }))).toBe(
      "When a text matches your 1 rule"
    );
    expect(friendlyTriggerLabel(def({ channel: "sms", conditions: [CONTAINS, CONTAINS] }))).toBe(
      "When a text matches your 2 rules"
    );
    // The specific string that started this: no "webhook", no "condition(s)".
    const webhook = friendlyTriggerLabel(def({ channel: "webhook", conditions: [CONTAINS] }));
    expect(webhook).toBe("When another system sends something in matching your 1 rule");
    expect(webhook).not.toMatch(/webhook|condition\(s\)/);
  });

  it("leaves the channels that already read as English to the schema", () => {
    // Calendar, schedule, tags, birthdays and voice are already plain there, so
    // they are not duplicated here where the two copies could drift apart.
    const calendar = def({ channel: "calendar", on: "event_end", followMinutes: 60, calendar: "both", conditions: [] });
    expect(friendlyTriggerLabel(calendar)).toBe("1 hour after a calendar event ends");
    expect(friendlyTriggerLabel(def({ channel: "schedule", everyMinutes: 30 }))).toBe(
      "Every 30 minutes"
    );
  });
});

describe("friendlyFlowSummary", () => {
  it("reads as when-then, with the steps as their friendly labels", () => {
    const summary = friendlyFlowSummary(
      def({ channel: "sms", conditions: [] }, [
        { id: "a", type: "extract_text", fields: [{ name: "x", description: "y" }] },
        { id: "b", type: "notify_owner", message: "hi" }
      ])
    );
    expect(summary).toBe(
      "When anyone texts you: Read details from the message text → Notify me"
    );
  });

  it("mentions extra triggers exactly once", () => {
    // The schema's own summary appends this tail too, so a channel that falls
    // through to it could easily end up saying it twice.
    const calendar = def(
      { channel: "calendar", on: "event_end", calendar: "both", conditions: [] },
      [{ id: "a", type: "notify_owner", message: "hi" }]
    );
    const withExtra = { ...calendar, triggers: [{ channel: "sms", conditions: [] }] } as AiFlowDefinition;
    expect(friendlyFlowSummary(withExtra).match(/or 1 other trigger/g)).toHaveLength(1);

    const sms = { ...def({ channel: "sms", conditions: [] }), triggers: [{ channel: "sms", conditions: [] }, { channel: "email", conditions: [] }] } as AiFlowDefinition;
    expect(friendlyFlowSummary(sms)).toBe("When anyone texts you (or 2 other triggers)");
  });

  it("describes the Prospecting flow in terms its owner can act on", () => {
    // Pinned on the WORDING, not the step list: which steps that template
    // carries is its own test's business, and this one should not fail when it
    // gains or loses one.
    const summary = friendlyFlowSummary(prospectOutreachTemplate().definition);
    expect(summary).toMatch(
      /^When another system sends something in matching your 1 rule: Read details from the message text/
    );
    expect(summary).not.toMatch(/webhook|condition\(s\)|extract_text|upsert_customer/);
    // The technical phrasing still exists for the surfaces that want it, which
    // is why this function exists rather than a rewrite of the schema's.
    expect(summarizeDefinition(prospectOutreachTemplate().definition)).toContain(
      "webhook event matches 1 condition(s)"
    );
  });
});
