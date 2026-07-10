import { describe, expect, it } from "vitest";
import {
  FLOW_COMPILE_SYSTEM_PROMPT,
  buildFlowAdaptUserText,
  buildFlowCompileUserText,
  buildFlowRepairUserText,
  extractFlowJson,
  humanizeCompileIssues
} from "@/lib/ai-flows/compile";

describe("FLOW_COMPILE_SYSTEM_PROMPT", () => {
  it("documents the schema contract", () => {
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"version": 1');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("browse_extract");
  });

  it("covers EVERY step type the schema supports (the generator must be able to author any flow)", () => {
    // Non-voice steps appear as JSON examples; voice steps in their own block.
    for (const type of [
      "extract_url",
      "browse_extract",
      "extract_text",
      "email_extract",
      "send_sms",
      "send_email",
      "approval_gate",
      "notify_owner",
      "http_call",
      "sleep",
      "wait_for_reply",
      "route_to_team",
      "browse_action",
      "recall_url",
      "upsert_customer",
      "update_contact",
      "classify",
      "ring_handoff",
      "voice_ai_intake",
      "voice_transfer",
      "outbound_call"
    ]) {
      expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain(`"type":"${type}"`);
    }
  });

  it("covers every trigger channel including voice (inbound + outbound)", () => {
    for (const channel of [
      "sms",
      "manual",
      "schedule",
      "tenant_email",
      "email",
      "webhook",
      "calendar",
      "voice"
    ]) {
      expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain(`"channel":"${channel}"`);
    }
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"direction":"outbound"');
  });

  it("documents the route_to_team knobs (keep-for-owner, firstToClaim, preferContactOwner)", () => {
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("ownerDirectWhen");
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("ownerDirectTemplate");
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"firstToClaim":false');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"preferContactOwner":true');
  });

  it("teaches the browse extras and forbids inventing saved-person refs", () => {
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("extractLinks");
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("skipWhenText");
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("integrationLabel");
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("can NOT be authored");
  });

  it("teaches the wait steps and the no-reply branching pattern", () => {
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"type":"sleep"');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"type":"wait_for_reply"');
    // The pattern Truly asked for ("wait 5 hours, follow up if no response")
    // must compile to wait_for_reply + a no_reply-guarded follow-up.
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"equals":"no_reply"');
  });

  it("offers every push trigger channel so the model never reaches for email+connectionId", () => {
    // The Truly Insurance live-demo failure (Jul 2026): the prompt omitted
    // tenant_email and webhook, so "when we receive an email from Privyr"
    // compiled to the `email` channel, whose connectionId the model cannot
    // know — validation rejected every attempt. These channels are the
    // no-uuid alternatives the model must be able to pick.
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"channel":"tenant_email"');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain('"channel":"webhook"');
    expect(FLOW_COMPILE_SYSTEM_PROMPT).toContain("NEVER invent or placeholder the uuid");
  });
});

describe("buildFlowCompileUserText", () => {
  it("trims and labels the description", () => {
    expect(buildFlowCompileUserText("  do a thing  ")).toBe("Automation description:\ndo a thing");
  });
});

describe("buildFlowAdaptUserText", () => {
  it("includes the source definition and the business's concrete details", () => {
    const text = buildFlowAdaptUserText({
      sourceDefinition: { version: 1 },
      ownerPhone: "+14805551234",
      ownerEmail: "owner@biz.com",
      employeeNames: ["Jordan", "Amy"],
      instructions: "only text buyers"
    });
    expect(text).toContain('{"version":1}');
    expect(text).toContain("Owner phone: +14805551234");
    expect(text).toContain("Owner email: owner@biz.com");
    expect(text).toContain("Team members: Jordan, Amy");
    expect(text).toContain("Additional instructions: only text buyers");
  });

  it("falls back to '(none on file)' and omits empty instructions", () => {
    const text = buildFlowAdaptUserText({ sourceDefinition: {} });
    expect(text).toContain("Owner phone: (none on file)");
    expect(text).toContain("Owner email: (none on file)");
    expect(text).toContain("Team members: (none on file)");
    expect(text).not.toContain("Additional instructions:");
  });

  it("treats whitespace-only instructions as empty", () => {
    const text = buildFlowAdaptUserText({ sourceDefinition: {}, instructions: "   " });
    expect(text).not.toContain("Additional instructions:");
  });
});

describe("buildFlowRepairUserText", () => {
  it("carries the issues, the failing JSON, and the original description", () => {
    const text = buildFlowRepairUserText({
      description: "  wait then text  ",
      candidateJson: '{"version":1}',
      issues: ["steps.0.minutes: too big", 'Step "w" waits for a reply from {{vars.x}}']
    });
    expect(text).toContain("FAILED validation");
    expect(text).toContain("- steps.0.minutes: too big");
    expect(text).toContain('{"version":1}');
    expect(text).toContain("wait then text");
  });
});

describe("humanizeCompileIssues", () => {
  it("maps connectionId failures to the coworker-mailbox guidance", () => {
    const [msg] = humanizeCompileIssues([
      "trigger.connectionId: Invalid input: expected string, received undefined"
    ]);
    expect(msg).toContain("AI coworker's own address");
    expect(msg).toContain("needs no connection");
  });
  it("rewrites other trigger problems with a what-to-try hint", () => {
    const [msg] = humanizeCompileIssues(["trigger.time: must be a 24h time like \"21:00\""]);
    expect(msg).toContain("problem with the trigger");
  });
  it("adds the extraction tip to out-of-scope var references", () => {
    const [msg] = humanizeCompileIssues([
      'Step "s3" uses {{vars.lead_phone}} before any step produces it.'
    ]);
    expect(msg).toContain("read details");
  });
  it("turns zod step paths into 1-based plain words and passes the rest through", () => {
    const [stepMsg, bareStepMsg, plain] = humanizeCompileIssues([
      "steps.1.body: String must contain at least 1 character(s)",
      "steps.0: browse_extract needs at least one of fields or extractLinks",
      'Duplicate step id "s1".'
    ]);
    expect(stepMsg).toContain("Step 2");
    expect(stepMsg).toContain("(body)");
    expect(bareStepMsg).toBe("Step 1: browse_extract needs at least one of fields or extractLinks");
    expect(plain).toBe('Duplicate step id "s1".');
  });
});

describe("extractFlowJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractFlowJson('{"version":1}')).toEqual({ version: 1 });
  });
  it("recovers JSON from fenced/prose output", () => {
    const raw = 'Here you go:\n```json\n{"version":1,"steps":[]}\n```\nHope that helps!';
    expect(extractFlowJson(raw)).toEqual({ version: 1, steps: [] });
  });
  it("returns null when there is no object", () => {
    expect(extractFlowJson("sorry, I cannot help")).toBeNull();
  });
  it("returns null when braces are out of order", () => {
    expect(extractFlowJson("} oops {")).toBeNull();
  });
  it("returns null when there is no closing brace", () => {
    expect(extractFlowJson("{ broken")).toBeNull();
  });
  it("returns null when the sliced region is invalid JSON", () => {
    expect(extractFlowJson("prefix { not: valid } suffix")).toBeNull();
  });
});
