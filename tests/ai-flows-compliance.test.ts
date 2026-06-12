import { describe, expect, it, vi } from "vitest";
import {
  STOP_SUFFIX,
  UCS2_MAX_SENDABLE_CHARS,
  ensureStopLanguage,
  gsmSafeSmsText,
  isRecipientOptedOut,
  type ComplianceRpcClient
} from "../supabase/functions/_shared/ai_flows/compliance";

describe("ensureStopLanguage", () => {
  it("leaves a body that already mentions STOP unchanged", () => {
    const body = "Hi! Reply STOP to opt out anytime.";
    expect(ensureStopLanguage(body)).toBe(body);
  });
  it("appends the suffix to a normal body", () => {
    expect(ensureStopLanguage("  Are you still selling?  ")).toBe(
      `Are you still selling? ${STOP_SUFFIX}`
    );
  });
  it("returns just the suffix for an empty body", () => {
    expect(ensureStopLanguage("   ")).toBe(STOP_SUFFIX);
  });
  it("supports a custom suffix", () => {
    expect(ensureStopLanguage("Yo", "Txt STOP to end.")).toBe("Yo Txt STOP to end.");
  });
});

describe("gsmSafeSmsText", () => {
  it("returns plain ASCII unchanged", () => {
    const body = "Hi Domenico. Call me at 602-695-1142!";
    expect(gsmSafeSmsText(body)).toBe(body);
  });
  it("normalizes smart punctuation to ASCII equivalents", () => {
    expect(gsmSafeSmsText("I\u2019d love to \u201Chelp\u201D \u2014 anytime\u2026")).toBe(
      "I'd love to \"help\" - anytime..."
    );
    expect(gsmSafeSmsText("a\u00A0b \u2013 c \u02BCd")).toBe("a b - c 'd");
  });
  it("converts common smiley emoji to an emoticon", () => {
    expect(gsmSafeSmsText("Thanks, Amy \u{1F60A}")).toBe("Thanks, Amy :-)");
    expect(gsmSafeSmsText("\u{1F600}\u{1F603}\u{1F604}\u{1F642}")).toBe(":-):-):-):-)");
  });
  it("keeps unmapped non-ASCII when the message fits the UCS-2 send cap", () => {
    const short = `caf\u00E9 ${"x".repeat(50)}`;
    expect(gsmSafeSmsText(short)).toBe(short);
  });
  it("strips remaining non-ASCII when keeping it would make the message unsendable", () => {
    const long = `caf\u00E9 \u{1F680} ${"x".repeat(UCS2_MAX_SENDABLE_CHARS)}`;
    const out = gsmSafeSmsText(long);
    expect(out).toBe(`caf  ${"x".repeat(UCS2_MAX_SENDABLE_CHARS)}`);
    expect(/[^\x00-\x7F]/.test(out)).toBe(false);
  });
  it("fixes the live failure shape: long body with emoji becomes a single-encoding GSM message", () => {
    const body = `Hi {{lead}}.\n\nI\u2019m licensed since 1989\u2026 ${"long text ".repeat(120)}Thanks, Amy \u{1F60A}`;
    const out = gsmSafeSmsText(body);
    expect(/[^\x00-\x7F]/.test(out)).toBe(false);
    expect(out).toContain("I'm licensed since 1989...");
    expect(out).toContain("Thanks, Amy :-)");
  });
});

describe("isRecipientOptedOut", () => {
  function client(data: unknown, error: { message: string } | null = null): ComplianceRpcClient {
    return { rpc: vi.fn().mockResolvedValue({ data, error }) };
  }
  it("returns true when the RPC says opted out", async () => {
    expect(await isRecipientOptedOut(client(true), "biz", "+16026866672")).toBe(true);
  });
  it("returns false otherwise", async () => {
    expect(await isRecipientOptedOut(client(false), "biz", "+16026866672")).toBe(false);
    expect(await isRecipientOptedOut(client(null), "biz", "+16026866672")).toBe(false);
  });
  it("throws on RPC error", async () => {
    await expect(
      isRecipientOptedOut(client(null, { message: "db down" }), "biz", "+1")
    ).rejects.toThrow("sms_is_opted_out: db down");
  });
});
