/**
 * Source pins: the webhook must run offer-reply matching on the stripped
 * body. normalizeOfferReply itself is tested in ai-flows-dave-timeframe;
 * this file guards the call sites a unit test of the parser cannot see,
 * because telnyx-sms-inbound is Deno and outside coverage.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const webhook = readFileSync("supabase/functions/telnyx-sms-inbound/index.ts", "utf8");
const worker = readFileSync("supabase/functions/sms-inbound-worker/index.ts", "utf8");

describe("offer reply wrapping is stripped at every digit gate", () => {
  it("normalizes once, then the bare 86 and 1-9 gates read that form", () => {
    expect(webhook).toContain("const offerReplyBody = normalizeOfferReply(replyBody)");
    expect(webhook).toContain('if (offerReplyBody === "86"');
    expect(webhook).toContain("if (/^[1-9]$/.test(offerReplyBody))");
    expect(webhook).toContain('const bareClaim = offerReplyBody === "1"');
    expect(webhook).toContain('const barePass = offerReplyBody === "2"');
  });

  it("does not leave the raw body on the live claim/pass digit", () => {
    expect(webhook).not.toContain("const bareClaim = replyBody === \"1\"");
    expect(webhook).not.toContain("if (/^[1-9]$/.test(replyBody))");
  });

  it("follow-up matching still sees the raw body (not a digit reply)", () => {
    expect(webhook).toContain("body: replyBody");
  });
});

describe("staff coworker cannot promise a claim", () => {
  it("injects SMS_STAFF_CLAIM_LINE on the team/owner Rowboat path", () => {
    expect(worker).toContain("SMS_STAFF_CLAIM_LINE");
  });
});
