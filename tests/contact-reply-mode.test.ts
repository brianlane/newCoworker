import { describe, expect, it } from "vitest";
import { SMS_REPLY_MODES as APP_SMS_REPLY_MODES } from "@/lib/customer-memory/types";
import {
  OWNER_REPLY_PROMPT_FRESHNESS_MS,
  SMS_REPLY_MODES,
  buildOwnerReplyAck,
  buildOwnerReplyPromptSms,
  isPromptFresh,
  isRelayableOwnerReply,
  resolveSmsReplyMode
} from "../supabase/functions/_shared/contact_reply_mode";

describe("SMS_REPLY_MODES lockstep (app types vs edge _shared vs DB check)", () => {
  it("app and edge lists are identical", () => {
    expect([...APP_SMS_REPLY_MODES]).toEqual([...SMS_REPLY_MODES]);
  });
});

describe("resolveSmsReplyMode", () => {
  it("passes through known modes", () => {
    expect(resolveSmsReplyMode("auto")).toBe("auto");
    expect(resolveSmsReplyMode("suppress")).toBe("suppress");
    expect(resolveSmsReplyMode("forward_owner")).toBe("forward_owner");
  });

  it("degrades anything unknown to 'auto' (fail-open to today's behavior)", () => {
    expect(resolveSmsReplyMode(null)).toBe("auto");
    expect(resolveSmsReplyMode(undefined)).toBe("auto");
    expect(resolveSmsReplyMode("")).toBe("auto");
    expect(resolveSmsReplyMode("SUPPRESS")).toBe("auto");
    expect(resolveSmsReplyMode(42)).toBe("auto");
    expect(resolveSmsReplyMode({})).toBe("auto");
  });
});

describe("isPromptFresh", () => {
  const now = Date.parse("2026-07-02T12:00:00Z");

  it("fresh within the window, stale after", () => {
    expect(isPromptFresh("2026-07-02T11:00:00Z", now)).toBe(true);
    expect(
      isPromptFresh(new Date(now - OWNER_REPLY_PROMPT_FRESHNESS_MS).toISOString(), now)
    ).toBe(true);
    expect(
      isPromptFresh(new Date(now - OWNER_REPLY_PROMPT_FRESHNESS_MS - 1000).toISOString(), now)
    ).toBe(false);
  });

  it("unparseable timestamps are never fresh (fail-closed: no accidental relay)", () => {
    expect(isPromptFresh("not-a-date", now)).toBe(false);
    expect(isPromptFresh("", now)).toBe(false);
  });
});

describe("buildOwnerReplyPromptSms", () => {
  it("includes the contact label, the message, and the question", () => {
    const text = buildOwnerReplyPromptSms({
      customerLabel: "Ken",
      inboundText: "Is the house still available?"
    });
    expect(text).toContain("[Reply needed] Ken: Is the house still available?");
    expect(text).toContain("What would you like me to say?");
  });

  it("caps the inbound body at 1000 chars and the whole SMS at 1600 (Safe-Mode forward contract)", () => {
    const text = buildOwnerReplyPromptSms({
      customerLabel: "+15555550123",
      inboundText: "x".repeat(5000)
    });
    // Inbound slice: exactly 1000 x's present, not 1001.
    expect(text).toContain("x".repeat(1000));
    expect(text).not.toContain("x".repeat(1001));
    expect(text.length).toBeLessThanOrEqual(1600);
  });
});

describe("buildOwnerReplyAck", () => {
  it("names the recipient", () => {
    expect(buildOwnerReplyAck("Ken")).toBe("Sent to Ken.");
  });
});

describe("isRelayableOwnerReply", () => {
  it("relays ordinary free text", () => {
    expect(isRelayableOwnerReply("Tell him the house sold last week, sorry!")).toBe(true);
    expect(isRelayableOwnerReply("  Yes, 3pm works.  ")).toBe(true);
    // Digits inside a sentence are fine — only BARE digits are reserved.
    expect(isRelayableOwnerReply("Call me at 602-555-1234")).toBe(true);
  });

  it("never relays bare digits (approval/claim vocabulary) or the 86 unclaim keyword", () => {
    expect(isRelayableOwnerReply("1")).toBe(false);
    expect(isRelayableOwnerReply("2")).toBe(false);
    expect(isRelayableOwnerReply(" 9 ")).toBe(false);
    expect(isRelayableOwnerReply("86")).toBe(false);
  });

  it("never relays empty/whitespace", () => {
    expect(isRelayableOwnerReply("")).toBe(false);
    expect(isRelayableOwnerReply("   ")).toBe(false);
  });
});
