import { describe, expect, it, vi } from "vitest";
import {
  SMS_MAX_BODY_CHARS,
  STOP_SUFFIX,
  UCS2_MAX_SENDABLE_CHARS,
  ensureStopLanguage,
  gsmSafeSmsText,
  isRecipientOptedOut,
  prepareSmsBody,
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
  it("replaces every space-like character that is not GSM-7 with a plain space", () => {
    // U+202F is the live one: Intl.DateTimeFormat puts it before AM/PM, so a
    // reminder text that quotes a time carries it and silently re-encodes as
    // UCS-2. The rest of the family is covered because a formatter or a paste
    // can produce any of them and they fail exactly the same way.
    expect(gsmSafeSmsText("Talk at 6:30\u202FPM.")).toBe("Talk at 6:30 PM.");
    const family = "a\u00A0b\u1680c\u2000d\u2005e\u200Af\u202Fg\u205Fh\u3000i";
    expect(gsmSafeSmsText(family)).toBe("a b c d e f g h i");
    expect(/[^\x00-\x7F]/.test(gsmSafeSmsText(family))).toBe(false);
  });
  it("keeps a time-quoting reminder on GSM-7 encoding rather than doubling it", () => {
    // The whole point, stated as the carrier sees it: 300+ characters is two
    // GSM segments and five UCS-2 segments, and one invisible character was
    // the only thing standing between them.
    const raw = `Reminder: your call with Amy is at 6:30\u202FPM today. ${"Reply here if anything changes. ".repeat(9)}`;
    expect(raw.length).toBeGreaterThan(160);
    expect(/[^\x00-\x7F]/.test(raw)).toBe(true);
    expect(/[^\x00-\x7F]/.test(gsmSafeSmsText(raw))).toBe(false);
  });
  it("leaves zero-width characters alone so emoji and Indic text survive", () => {
    // U+200D joins the people in a family emoji and U+200C separates letters
    // in Persian/Indic scripts. Deleting them would corrupt content this
    // function otherwise keeps intact, so they are deliberately not listed.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(gsmSafeSmsText(family)).toBe(family);
    expect(gsmSafeSmsText("\u0645\u06CC\u200C\u062E\u0648\u0627\u0646\u0645")).toContain("\u200C");
  });
  it("keeps emoji intact when the message fits the UCS-2 send cap", () => {
    expect(gsmSafeSmsText("Thanks, Amy \u{1F60A}")).toBe("Thanks, Amy \u{1F60A}");
    expect(gsmSafeSmsText("\u{1F600}\u{1F603}\u{1F604}\u{1F642}")).toBe(
      "\u{1F600}\u{1F603}\u{1F604}\u{1F642}"
    );
  });
  it("downgrades smileys to an emoticon only when the body is too long to ship as UCS-2", () => {
    const long = `Thanks, Amy \u{1F60A} ${"x".repeat(UCS2_MAX_SENDABLE_CHARS)}`;
    const out = gsmSafeSmsText(long);
    expect(out).toContain("Thanks, Amy :-)");
    expect(/[^\x00-\x7F]/.test(out)).toBe(false);
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

describe("prepareSmsBody", () => {
  it("passes a short ASCII body through unchanged (no STOP requested)", () => {
    expect(prepareSmsBody("See you at 2pm.")).toBe("See you at 2pm.");
  });
  it("normalizes punctuation and appends STOP for cold sends", () => {
    expect(prepareSmsBody("I\u2019m Amy \u2014 are you selling?", { requireStop: true })).toBe(
      `I'm Amy - are you selling? ${STOP_SUFFIX}`
    );
  });
  it("strips kept emoji when the STOP suffix would push a UCS-2 body past the send cap", () => {
    // Body sits just UNDER the UCS-2 cap with an unmapped emoji kept; the
    // appended suffix would exceed it, the rocket must be stripped, never
    // shipped as an unsendable 11-segment message.
    const body = `\u{1F680} ${"x".repeat(UCS2_MAX_SENDABLE_CHARS - 10)}`;
    const out = prepareSmsBody(body, { requireStop: true });
    expect(/[^\x00-\x7F]/.test(out)).toBe(false);
    expect(out.endsWith(STOP_SUFFIX)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(UCS2_MAX_SENDABLE_CHARS + STOP_SUFFIX.length + 1);
  });
  it("keeps a short emoji body intact, suffix included, when it still fits UCS-2", () => {
    const out = prepareSmsBody("Caf\u00E9 tour this week?", { requireStop: true });
    expect(out).toBe(`Caf\u00E9 tour this week? ${STOP_SUFFIX}`);
  });
  it("ships real smiley emoji (not :-)) when the cold body is short enough to deliver", () => {
    const out = prepareSmsBody("Thanks, Amy \u{1F60A}", { requireStop: true });
    expect(out).toBe(`Thanks, Amy \u{1F60A} ${STOP_SUFFIX}`);
  });
  it("caps an over-long ASCII body at the GSM ceiling", () => {
    const out = prepareSmsBody("y".repeat(SMS_MAX_BODY_CHARS + 200));
    expect(out.length).toBe(SMS_MAX_BODY_CHARS);
  });
  it("re-appends STOP after truncating an over-long cold body, never cutting the suffix off", () => {
    const out = prepareSmsBody("y".repeat(SMS_MAX_BODY_CHARS + 200), { requireStop: true });
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_BODY_CHARS);
    expect(out.endsWith(STOP_SUFFIX)).toBe(true);
  });
  it("cuts an over-long body on a word boundary and marks the cut", () => {
    // "Budget around $412K" must not ship as "Bud" (the text_truncate.ts
    // case): the last surviving word is whole and the cut is visible.
    const out = prepareSmsBody(`${"word ".repeat(SMS_MAX_BODY_CHARS)}tail`);
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_BODY_CHARS);
    expect(out.endsWith("word...")).toBe(true);
  });
  it("keeps the cap after the ellipsis expands from one character to three", () => {
    // truncateAtWord marks the cut with "…", which gsmSafeSmsText turns into
    // "..."; without reserving those two characters the cut body lands back
    // OVER the cap it was supposed to enforce.
    for (const extra of [1, 2, 3, 200]) {
      const out = prepareSmsBody(`${"ab ".repeat(SMS_MAX_BODY_CHARS)}`.slice(0, SMS_MAX_BODY_CHARS + extra));
      expect(out.length).toBeLessThanOrEqual(SMS_MAX_BODY_CHARS);
    }
  });
  it("still fits the STOP suffix when the truncated body ends in an ellipsis", () => {
    const out = prepareSmsBody(`${"word ".repeat(SMS_MAX_BODY_CHARS)}tail`, { requireStop: true });
    expect(out.length).toBeLessThanOrEqual(SMS_MAX_BODY_CHARS);
    expect(out.endsWith(STOP_SUFFIX)).toBe(true);
    expect(out).toContain("...");
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
