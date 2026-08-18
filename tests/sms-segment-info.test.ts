import { describe, expect, it } from "vitest";
import { smsSegmentInfo, smsTextUnits, MMS_TEXT_UNITS, UCS2_MAX_SENDABLE_CHARS } from "@/lib/sms/segment-info";
import {
  smsTextUnits as edgeSmsTextUnits,
  MMS_TEXT_UNITS as EDGE_MMS_TEXT_UNITS
} from "../supabase/functions/_shared/sms_text_units";

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
      // converted or stripped, the hint must not warn.
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

describe("smsTextUnits", () => {
  it("charges one unit per GSM part, minimum 1", () => {
    expect(smsTextUnits("")).toBe(1);
    expect(smsTextUnits("Hi")).toBe(1);
    expect(smsTextUnits("a".repeat(160))).toBe(1);
    expect(smsTextUnits("a".repeat(161))).toBe(2);
    expect(smsTextUnits("a".repeat(307))).toBe(3);
  });

  it("charges UCS-2 parts when the body carries emoji", () => {
    // The emoji is a surrogate pair: JS length 2, same as the worker's check.
    expect(smsTextUnits(`\u{1F60A}${"a".repeat(68)}`)).toBe(1);
    expect(smsTextUnits(`\u{1F60A}${"a".repeat(69)}`)).toBe(2);
  });

  it("regression: a 1,342-char ai_flow body reserves 9 units, not 1", () => {
    // Amy's real 10-part-era message length; under the old meter this
    // counted as ONE message while Telnyx billed every part.
    expect(smsTextUnits("a".repeat(1342))).toBe(9);
  });

  it("any media makes the send a flat-rate MMS regardless of caption length", () => {
    expect(smsTextUnits("", { mediaCount: 1 })).toBe(MMS_TEXT_UNITS);
    expect(smsTextUnits("a".repeat(1600), { mediaCount: 2 })).toBe(MMS_TEXT_UNITS);
    expect(MMS_TEXT_UNITS).toBeCloseTo(2.2);
  });

  it("stays in lockstep with the Edge copy across a boundary matrix", () => {
    const cases: Array<[string, number]> = [
      ["", 0],
      ["hi", 0],
      ["a".repeat(160), 0],
      ["a".repeat(161), 0],
      ["a".repeat(1342), 0],
      [`\u{1F60A}${"a".repeat(70)}`, 0],
      ["a".repeat(500), 1],
      ["", 3]
    ];
    for (const [text, mediaCount] of cases) {
      expect(edgeSmsTextUnits(text, { mediaCount })).toBe(smsTextUnits(text, { mediaCount }));
    }
    expect(EDGE_MMS_TEXT_UNITS).toBe(MMS_TEXT_UNITS);
  });
});
