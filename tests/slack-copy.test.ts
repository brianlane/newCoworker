/**
 * Tests for the fixed Slack-side strings (src/lib/slack/copy.ts): both
 * locales exist, English is the default, and an unknown locale falls back
 * to English instead of posting undefined into a workspace.
 */
import { describe, expect, it } from "vitest";

import { slackAlertChannelHelloMessage } from "@/lib/slack/copy";

describe("slackAlertChannelHelloMessage", () => {
  it("serves English by default and Spanish on request", () => {
    expect(slackAlertChannelHelloMessage()).toMatch(/New Coworker/);
    expect(slackAlertChannelHelloMessage("en")).toMatch(/Alerts for your business/);
    expect(slackAlertChannelHelloMessage("es")).toMatch(/avisos de tu negocio/);
  });

  it("falls back to English on an unknown locale", () => {
    expect(slackAlertChannelHelloMessage("fr" as never)).toMatch(/New Coworker/);
  });
});
