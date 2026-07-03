import { describe, expect, it } from "vitest";
import {
  EMAIL_WINDOW_TEXT_MAX,
  emailTriggerScope,
  evaluateTriggerConditions,
  firstUrlInText,
  htmlToText,
  manualTriggerScope,
  safeRegexTest,
  tenantEmailTriggerScope
} from "@/lib/ai-flows/trigger-eval";

describe("firstUrlInText", () => {
  it("finds a url and trims trailing punctuation", () => {
    expect(firstUrlInText("see https://rfrl.to/abc123.")).toBe("https://rfrl.to/abc123");
  });
  it("returns null when no url present", () => {
    expect(firstUrlInText("no link here")).toBeNull();
  });
});

describe("safeRegexTest", () => {
  it("matches case-insensitively by default and respects the flag", () => {
    expect(safeRegexTest("LEAD", "new lead", undefined)).toBe(true);
    expect(safeRegexTest("LEAD", "new lead", false)).toBe(false);
  });
  it("never throws on an invalid pattern", () => {
    expect(safeRegexTest("([", "anything")).toBe(false);
  });
});

describe("evaluateTriggerConditions", () => {
  const text = "New referral: https://rfrl.to/x from Jane";
  it("ANDs all conditions; empty list matches everything", () => {
    expect(evaluateTriggerConditions([], text, "a@b.c")).toBe(true);
    expect(
      evaluateTriggerConditions(
        [
          { type: "contains", value: "REFERRAL" },
          { type: "has_url" },
          { type: "from_matches", value: "@b.c" }
        ],
        text,
        "jane@b.c"
      )
    ).toBe(true);
    expect(
      evaluateTriggerConditions([{ type: "contains", value: "nope" }, { type: "has_url" }], text, "")
    ).toBe(false);
  });
  it("supports regex and case-sensitive contains", () => {
    expect(evaluateTriggerConditions([{ type: "regex", value: "rfrl\\.to/\\w+" }], text, "")).toBe(
      true
    );
    expect(
      evaluateTriggerConditions(
        [{ type: "contains", value: "REFERRAL", caseInsensitive: false }],
        text,
        ""
      )
    ).toBe(false);
  });
  it("from_matches tests the sender, not the text", () => {
    expect(evaluateTriggerConditions([{ type: "from_matches", value: "jane" }], text, "bob@x.y")).toBe(
      false
    );
  });
  it("matches a from_matches contact ref against pre-resolved identity values", () => {
    const ref = { source: "employee" as const, id: "11111111-1111-4111-8111-111111111111" };
    const conditions = [{ type: "from_matches" as const, ref }];
    const refValues = new Map([
      ["employee:11111111-1111-4111-8111-111111111111", ["+16025551234", "dave@x.com"]]
    ]);
    expect(evaluateTriggerConditions(conditions, text, "dave@x.com", refValues)).toBe(true);
    expect(evaluateTriggerConditions(conditions, text, "bob@x.y", refValues)).toBe(false);
    // No pre-resolved entry (deleted person / resolution failure) fails closed.
    expect(evaluateTriggerConditions(conditions, text, "dave@x.com")).toBe(false);
  });
  it("fails a from_matches with neither value nor ref (malformed row)", () => {
    const conditions = [{ type: "from_matches" }] as unknown as Parameters<
      typeof evaluateTriggerConditions
    >[0];
    expect(evaluateTriggerConditions(conditions, text, "dave@x.com")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("strips tags/scripts and decodes entities without double-unescaping", () => {
    const html =
      "<html><style>p{}</style><script>x()</script><p>Hi&nbsp;there &amp;lt; you</p></html>";
    expect(htmlToText(html)).toBe("Hi there &lt; you");
  });
});

describe("manualTriggerScope", () => {
  it("extracts the url and stamps the starter", () => {
    expect(manualTriggerScope("  check https://x.com/lead  ", "owner@biz.com")).toEqual({
      channel: "manual",
      windowText: "check https://x.com/lead",
      url: "https://x.com/lead",
      from: "owner@biz.com"
    });
  });
  it("handles empty input", () => {
    expect(manualTriggerScope("", "owner@biz.com")).toEqual({
      channel: "manual",
      windowText: "",
      url: null,
      from: "owner@biz.com"
    });
  });
});

describe("emailTriggerScope", () => {
  it("combines subject + body, finds the url, and keeps provenance", () => {
    const scope = emailTriggerScope({
      id: "m1",
      fromEmail: "leads@referralexchange.com",
      subject: "New lead",
      bodyText: "Open https://rfrl.to/abc",
      receivedAt: "2026-06-09T15:00:00Z"
    });
    expect(scope).toEqual({
      channel: "email",
      windowText: "New lead\nOpen https://rfrl.to/abc",
      url: "https://rfrl.to/abc",
      from: "leads@referralexchange.com",
      subject: "New lead",
      message_id: "m1",
      received_at: "2026-06-09T15:00:00Z"
    });
  });
  it("clips oversized bodies and omits received_at when unknown", () => {
    const scope = emailTriggerScope({
      id: "m2",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "x".repeat(EMAIL_WINDOW_TEXT_MAX + 500)
    });
    expect(scope.windowText.length).toBe(EMAIL_WINDOW_TEXT_MAX);
    expect("received_at" in scope).toBe(false);
  });
});

describe("tenantEmailTriggerScope", () => {
  it("tags the tenant_email channel and keeps the recipient + provenance", () => {
    const scope = tenantEmailTriggerScope({
      id: "m1",
      fromEmail: "jane@example.com",
      subject: "New lead",
      bodyText: "Open https://rfrl.to/abc",
      toEmail: "amy@newcoworker.com",
      receivedAt: "2026-06-09T15:00:00Z"
    });
    expect(scope).toEqual({
      channel: "tenant_email",
      windowText: "New lead\nOpen https://rfrl.to/abc",
      url: "https://rfrl.to/abc",
      from: "jane@example.com",
      subject: "New lead",
      message_id: "m1",
      to: "amy@newcoworker.com",
      received_at: "2026-06-09T15:00:00Z"
    });
  });
  it("omits to and received_at when unknown", () => {
    const scope = tenantEmailTriggerScope({
      id: "m2",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "body"
    });
    expect("to" in scope).toBe(false);
    expect("received_at" in scope).toBe(false);
  });
});
