/**
 * Tests for the Slack chat prompt blocks + fixed strings
 * (src/lib/slack/chat.ts): both locales exist, English is the default, and
 * the team preamble carries the guardrails the worker builds on (no em
 * dashes, owner-only powers named).
 */
import { describe, expect, it } from "vitest";

import {
  SLACK_REPLY_MAX_CHARS,
  SLACK_SURFACE_BLOCK,
  SLACK_TEAM_PREAMBLE,
  slackOnboardingMessage,
  slackOverCapMessage,
  slackTierBlockedMessage,
  slackTurnFailedMessage
} from "@/lib/slack/chat";

describe("prompt blocks", () => {
  it("the surface block names Slack formatting and the reply budget", () => {
    expect(SLACK_SURFACE_BLOCK).toContain("SLACK");
    expect(SLACK_SURFACE_BLOCK).toContain(String(SLACK_REPLY_MAX_CHARS));
  });

  it("the team preamble embeds the no-em-dash line and owner-only boundary", () => {
    expect(SLACK_TEAM_PREAMBLE).toContain("never use an em dash");
    expect(SLACK_TEAM_PREAMBLE).toContain("owner-only");
    expect(SLACK_TEAM_PREAMBLE.includes("—")).toBe(false);
  });
});

describe("fixed strings", () => {
  it.each([
    [slackOnboardingMessage, "New Coworker", "New Coworker"],
    [slackOverCapMessage, "AI budget", "presupuesto de IA"],
    [slackTierBlockedMessage, "Standard and Enterprise", "Standard y Enterprise"],
    [slackTurnFailedMessage, "Something went wrong", "Algo falló"]
  ] as const)("serves both locales with an English default", (fn, en, es) => {
    expect(fn()).toContain(en);
    expect(fn("en")).toContain(en);
    expect(fn("es")).toContain(es);
    expect(fn("fr" as never)).toContain(en);
  });
});
