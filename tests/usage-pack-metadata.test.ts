import { describe, expect, it } from "vitest";
import {
  parseChatCreditMicrosFromMetadata,
  parseSmsBonusTextsFromMetadata,
  parseVoiceBonusSecondsFromMetadata
} from "@/lib/billing/usage-pack-metadata";

describe("usage-pack-metadata parsers", () => {
  it("parses valid voice seconds and rejects malformed values", () => {
    expect(parseVoiceBonusSecondsFromMetadata("1800")).toBe(1800);
    expect(parseVoiceBonusSecondsFromMetadata(null)).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("0")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("1.5")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("1e3")).toBeNull();
    expect(parseVoiceBonusSecondsFromMetadata("9999999999")).toBeNull();
    // 9 digits, above one-year hard max (hits n > HARD_MAX, not length)
    expect(parseVoiceBonusSecondsFromMetadata("31536001")).toBeNull();
  });

  it("parses valid sms texts and rejects malformed values", () => {
    expect(parseSmsBonusTextsFromMetadata("500")).toBe(500);
    expect(parseSmsBonusTextsFromMetadata(undefined)).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("-1")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("0")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("1000001")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("12345678")).toBeNull();
    expect(parseSmsBonusTextsFromMetadata("12.0")).toBeNull();
  });

  it("parses valid chat micros and rejects malformed values", () => {
    expect(parseChatCreditMicrosFromMetadata("5000000")).toBe(5_000_000);
    expect(parseChatCreditMicrosFromMetadata(null)).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("0")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("1000000001")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("12345678901")).toBeNull();
    expect(parseChatCreditMicrosFromMetadata("abc")).toBeNull();
  });
});
