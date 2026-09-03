import { describe, expect, it } from "vitest";
import { classifyReplyTarget, isSmsShortcode } from "../supabase/functions/_shared/sms_sender";
import { e164CollapseKey, e164LookupValues, normalizeE164 } from "../supabase/functions/_shared/normalize_e164";

describe("isSmsShortcode", () => {
  it("recognizes the real short codes lead services blast from", () => {
    // ReferralExchange and Realtor.com, taken from a live inbox.
    expect(isSmsShortcode("73339")).toBe(true);
    expect(isSmsShortcode("72825")).toBe(true);
    expect(isSmsShortcode(" 22000 ")).toBe(true);
    expect(isSmsShortcode("123456")).toBe(true);
    expect(isSmsShortcode("789")).toBe(true);
  });

  it("never calls a phone number a short code", () => {
    // Getting this wrong would silently stop replying to a real person.
    expect(isSmsShortcode("+16025550100")).toBe(false);
    expect(isSmsShortcode("6025550100")).toBe(false);
    expect(isSmsShortcode("602-555-0100")).toBe(false);
    expect(isSmsShortcode("+1 602 555 0100")).toBe(false);
    expect(isSmsShortcode("1234567")).toBe(false);
  });

  it("is false for nothing at all", () => {
    expect(isSmsShortcode("")).toBe(false);
    expect(isSmsShortcode("   ")).toBe(false);
    expect(isSmsShortcode(null)).toBe(false);
    expect(isSmsShortcode(undefined)).toBe(false);
    expect(isSmsShortcode("abc")).toBe(false);
  });

  it("covers exactly the senders normalizeE164 refuses", () => {
    // The two functions are complementary: a short code is precisely the case
    // that is a valid origination address but not valid E.164.
    for (const code of ["73339", "72825", "89854"]) {
      expect(normalizeE164(code)).toBeNull();
      expect(isSmsShortcode(code)).toBe(true);
    }
  });
});

describe("classifyReplyTarget", () => {
  const alert = "ReferralExchange PRIME just matched you with a new seller!";

  it("replies to a normal text from a real number", () => {
    expect(
      classifyReplyTarget({ fromRaw: "+16025550100", fromE164: "+16025550100", text: "hi" })
    ).toEqual({ kind: "reply" });
  });

  it("skips a short-code blast instead of calling it a failure", () => {
    // Unreplyable by design (carriers reject texting a short code), and its
    // flows already ran in the webhook, so this is a completed job.
    expect(classifyReplyTarget({ fromRaw: "73339", fromE164: null, text: alert })).toEqual({
      kind: "skip",
      reason: "shortcode_sender"
    });
    // Also when it carried no text: still nothing to reply to, still not broken.
    expect(classifyReplyTarget({ fromRaw: "73339", fromE164: "", text: "" })).toEqual({
      kind: "skip",
      reason: "shortcode_sender"
    });
  });

  it("skips a real sender who sent nothing to answer", () => {
    expect(
      classifyReplyTarget({ fromRaw: "+16025550100", fromE164: "+16025550100", text: "   " })
    ).toEqual({ kind: "skip", reason: "no_text" });
  });

  it("fails only on a sender that is neither usable nor a short code", () => {
    // This is the case worth alerting on, and the only one that still
    // dead-letters.
    expect(classifyReplyTarget({ fromRaw: "1234567", fromE164: null, text: "hi" })).toEqual({
      kind: "fail"
    });
    expect(classifyReplyTarget({ fromRaw: "", fromE164: null, text: "hi" })).toEqual({
      kind: "fail"
    });
    expect(classifyReplyTarget({ fromRaw: "garbage", fromE164: "", text: "hi" })).toEqual({
      kind: "fail"
    });
  });
});

describe("e164CollapseKey / e164LookupValues", () => {
  it("collapses 10-digit NANP onto +1 E.164", () => {
    expect(e164CollapseKey("4803813509")).toBe("+14803813509");
    expect(e164CollapseKey("+14803813509")).toBe("+14803813509");
    expect(e164CollapseKey("")).toBe("");
    expect(e164LookupValues("4803813509")).toEqual(
      expect.arrayContaining(["+14803813509", "14803813509", "4803813509"])
    );
  });

  it("does not invent a 10-digit form for a non-NANP number", () => {
    expect(e164CollapseKey("+442071838750")).toBe("+442071838750");
    expect(e164LookupValues("+442071838750")).toEqual(["+442071838750", "442071838750"]);
  });
});
