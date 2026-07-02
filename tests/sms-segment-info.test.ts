import { describe, expect, it } from "vitest";
import { smsSegmentInfo, UCS2_MAX_SENDABLE_CHARS } from "@/lib/sms/segment-info";

describe("smsSegmentInfo", () => {
  it("treats plain ASCII as GSM", () => {
    const info = smsSegmentInfo("Hello there");
    expect(info).toMatchObject({
      encoding: "gsm",
      segments: 1,
      hasNonGsmChars: false,
      exceedsUcs2SendableLimit: false
    });
  });

  it("returns 0 segments for an empty message", () => {
    expect(smsSegmentInfo("").segments).toBe(0);
  });

  it("counts GSM segments: 160 single, 153 per part after that", () => {
    expect(smsSegmentInfo("a".repeat(160)).segments).toBe(1);
    expect(smsSegmentInfo("a".repeat(161)).segments).toBe(2);
    expect(smsSegmentInfo("a".repeat(306)).segments).toBe(2);
    expect(smsSegmentInfo("a".repeat(307)).segments).toBe(3);
  });

  it("a single emoji anywhere forces UCS-2 for the whole message", () => {
    const info = smsSegmentInfo("Sounds good \u{1F60A}");
    expect(info.encoding).toBe("ucs2");
    expect(info.hasNonGsmChars).toBe(true);
    expect(info.exceedsUcs2SendableLimit).toBe(false);
  });

  it("counts UCS-2 segments: 70 single, 67 per part after that", () => {
    expect(smsSegmentInfo("\u{1F60A}" + "a".repeat(68)).segments).toBe(1); // emoji = 2 UTF-16 units
    expect(smsSegmentInfo("\u{1F60A}" + "a".repeat(69)).segments).toBe(2);
  });

  it("smart punctuation also forces UCS-2 (matches the worker's non-ASCII test)", () => {
    expect(smsSegmentInfo("It\u2019s ready").encoding).toBe("ucs2");
  });

  it("flags emoji messages over the 670-char sendable cap", () => {
    const over = "a".repeat(UCS2_MAX_SENDABLE_CHARS) + "\u{1F60A}";
    const info = smsSegmentInfo(over);
    expect(info.exceedsUcs2SendableLimit).toBe(true);
    expect(info.length).toBeGreaterThan(UCS2_MAX_SENDABLE_CHARS);
  });

  it("does NOT flag long ASCII-only messages (they stay GSM)", () => {
    const info = smsSegmentInfo("a".repeat(700));
    expect(info.encoding).toBe("gsm");
    expect(info.exceedsUcs2SendableLimit).toBe(false);
  });

  it("does NOT flag emoji messages at exactly the cap", () => {
    // 670 chars total, last two are one emoji (2 UTF-16 units).
    const atCap = "a".repeat(UCS2_MAX_SENDABLE_CHARS - 2) + "\u{1F60A}";
    expect(atCap.length).toBe(UCS2_MAX_SENDABLE_CHARS);
    expect(smsSegmentInfo(atCap).exceedsUcs2SendableLimit).toBe(false);
  });

  describe("normalizeSmartPunctuation (aiflow mode)", () => {
    it("treats smart punctuation as GSM, matching the worker's gsmSafeSmsText", () => {
      // A long body whose only non-ASCII chars are smart punctuation: the
      // worker normalizes it to ASCII before the cap check, so nothing is
      // converted or stripped — the hint must not warn.
      const long = "It\u2019s a \u201Cbig\u201D deal \u2014 really\u2026 " + "a".repeat(700);
      const info = smsSegmentInfo(long, { normalizeSmartPunctuation: true });
      expect(info.encoding).toBe("gsm");
      expect(info.exceedsUcs2SendableLimit).toBe(false);
      // Without normalization (verbatim mode) the same text is over-cap UCS-2.
      expect(smsSegmentInfo(long).exceedsUcs2SendableLimit).toBe(true);
    });

    it("still flags emoji that survive normalization", () => {
      const long = "\u{1F60A} " + "a".repeat(700);
      const info = smsSegmentInfo(long, { normalizeSmartPunctuation: true });
      expect(info.encoding).toBe("ucs2");
      expect(info.exceedsUcs2SendableLimit).toBe(true);
    });

    it("measures length after normalization (ellipsis expands to three dots)", () => {
      expect(smsSegmentInfo("\u2026", { normalizeSmartPunctuation: true }).length).toBe(3);
    });
  });
});
