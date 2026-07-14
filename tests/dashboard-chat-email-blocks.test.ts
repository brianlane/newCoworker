/**
 * Platform-side EMAIL_SEND block handling
 * (src/lib/dashboard-chat/email-blocks.ts): extraction/validation parity
 * with the worker twin, honest outcome lines, and the inline fulfilment
 * pipeline with an injected sender.
 */
import { describe, expect, it, vi } from "vitest";

import {
  BODY_MAX_CHARS,
  EMAIL_SEND_CLOSE,
  EMAIL_SEND_OPEN,
  MAX_CC_BCC_RECIPIENTS,
  MAX_EMAILS_PER_TURN,
  SUBJECT_MAX_CHARS,
  appendEmailResults,
  describeEmailOutcome,
  extractEmailSendRequests,
  fulfillEmailBlocks
} from "@/lib/dashboard-chat/email-blocks";

function block(json: string): string {
  return `${EMAIL_SEND_OPEN}\n${json}\n${EMAIL_SEND_CLOSE}`;
}

describe("extractEmailSendRequests", () => {
  it("passes through content without blocks (and tolerates non-strings)", () => {
    expect(extractEmailSendRequests("plain reply")).toEqual({
      cleanedContent: "plain reply",
      requests: [],
      invalidCount: 0
    });
    expect(extractEmailSendRequests(undefined as unknown as string).cleanedContent).toBe("");
  });

  it("extracts a valid block, strips it, and normalizes cc/bcc", () => {
    const content = `Sending now.\n${block(
      '{"to": "A@B.co", "subject": "Hi", "body": "Body", "cc": ["c@d.co", "c@d.co", "bad"], "bcc": "e@f.co; g@h.co"}'
    )}\nDone.`;
    const out = extractEmailSendRequests(content);
    expect(out.requests).toEqual([
      { to: "A@B.co", subject: "Hi", body: "Body", cc: ["c@d.co"], bcc: ["e@f.co", "g@h.co"] }
    ]);
    expect(out.cleanedContent).not.toContain(EMAIL_SEND_OPEN);
    expect(out.cleanedContent).toContain("Sending now.");
    expect(out.invalidCount).toBe(0);
  });

  it("accepts the adapter alias field names (toEmail/bodyText)", () => {
    const out = extractEmailSendRequests(
      block('{"toEmail": "a@b.co", "subject": "s", "bodyText": "b"}')
    );
    expect(out.requests[0]).toMatchObject({ to: "a@b.co", body: "b" });
  });

  it("strips surrounding code fences the model added", () => {
    const content = "```json\n" + block('{"to": "a@b.co", "subject": "s", "body": "b"}') + "\n```";
    const out = extractEmailSendRequests(content);
    expect(out.requests).toHaveLength(1);
    expect(out.cleanedContent).not.toContain("```");
  });

  it("counts malformed blocks (bad JSON, arrays, invalid to, caps, missing/mistyped fields)", () => {
    const cases = [
      "not json",
      "[1,2]",
      '{"to": "not-an-email", "subject": "s", "body": "b"}',
      `{"to": "a@b.co", "subject": "${"s".repeat(SUBJECT_MAX_CHARS + 1)}", "body": "b"}`,
      `{"to": "a@b.co", "subject": "s", "body": "${"b".repeat(BODY_MAX_CHARS + 1)}"}`,
      '{"to": "a@b.co", "subject": "", "body": "b"}',
      '{"to": "a@b.co", "subject": "s", "body": "  "}',
      '{"subject": "s", "body": "b"}',
      '{"to": "a@b.co", "subject": "s"}',
      '{"to": "a@b.co", "body": "b"}',
      '{"to": 5, "subject": 5, "body": 5}',
      "null"
    ];
    const content = cases.map((c) => block(c)).join("\n");
    const out = extractEmailSendRequests(content);
    expect(out.requests).toHaveLength(0);
    expect(out.invalidCount).toBe(cases.length);
  });

  it("caps cc recipients at the limit and skips non-string array entries", () => {
    const cc = Array.from({ length: MAX_CC_BCC_RECIPIENTS + 5 }, (_, i) => `u${i}@x.co`);
    const out = extractEmailSendRequests(
      block(`{"to": "a@b.co", "subject": "s", "body": "b", "cc": ${JSON.stringify(cc)}}`)
    );
    expect(out.requests[0].cc).toHaveLength(MAX_CC_BCC_RECIPIENTS);
    const mixed = extractEmailSendRequests(
      block('{"to": "a@b.co", "subject": "s", "body": "b", "cc": [7, "c@d.co"], "bcc": 9}')
    );
    expect(mixed.requests[0].cc).toEqual(["c@d.co"]);
    expect(mixed.requests[0].bcc).toEqual([]);
  });

  it("truncated generation: a dangling OPEN is stripped to the end", () => {
    const content = `Reply text.\n${EMAIL_SEND_OPEN}\n{"to": "a@b.co", "subj`;
    const out = extractEmailSendRequests(content);
    expect(out.cleanedContent).toBe("Reply text.");
    expect(out.invalidCount).toBe(1);
  });
});

describe("describeEmailOutcome / appendEmailResults", () => {
  it("renders each outcome class honestly", () => {
    expect(describeEmailOutcome({ ok: true, to: "a@b.co", subject: "Hi" })).toContain("sent from");
    expect(
      describeEmailOutcome({ ok: false, to: "a@b.co", subject: "", detail: "tool_disabled" })
    ).toContain("turned off");
    expect(
      describeEmailOutcome({ ok: false, to: "a@b.co", subject: "", detail: "email_not_connected" })
    ).toContain("no email account");
    expect(
      describeEmailOutcome({ ok: false, to: "a@b.co", subject: "", detail: "too_many_emails" })
    ).toContain(`${MAX_EMAILS_PER_TURN}`);
    expect(
      describeEmailOutcome({ ok: false, to: "a@b.co", subject: "", detail: "invalid_block" })
    ).toContain("malformed");
    expect(describeEmailOutcome({ ok: false, to: "a@b.co", subject: "" })).toContain(
      "unknown error"
    );
  });

  it("appends result lines after a divider (or standalone on an empty reply)", () => {
    expect(appendEmailResults("Reply.", [{ ok: true, to: "a@b.co", subject: "" }])).toMatch(
      /Reply\.\n\n---\nEmail to a@b\.co/
    );
    expect(appendEmailResults("", [{ ok: true, to: "a@b.co", subject: "" }])).toMatch(
      /^Email to a@b\.co/
    );
    expect(appendEmailResults("Reply.", [])).toBe("Reply.");
  });
});

describe("fulfillEmailBlocks", () => {
  it("returns the reply unchanged when there are no blocks", async () => {
    const send = vi.fn();
    const out = await fulfillEmailBlocks({ content: "plain", send });
    expect(out).toEqual({ content: "plain", sentCount: 0, failedCount: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends valid blocks sequentially and appends honest outcomes", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, detail: "email_not_connected" });
    const content = [
      "Sending.",
      block('{"to": "a@b.co", "subject": "One", "body": "1"}'),
      block('{"to": "c@d.co", "subject": "Two", "body": "2"}')
    ].join("\n");
    const out = await fulfillEmailBlocks({ content, send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(out.sentCount).toBe(1);
    expect(out.failedCount).toBe(1);
    expect(out.content).toContain("sent from your connected mailbox");
    expect(out.content).toContain("no email account is connected");
    expect(out.content).not.toContain(EMAIL_SEND_OPEN);
  });

  it("caps sends at MAX_EMAILS_PER_TURN with an honest line for the overflow", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const blocks = Array.from({ length: MAX_EMAILS_PER_TURN + 1 }, (_, i) =>
      block(`{"to": "u${i}@x.co", "subject": "s", "body": "b"}`)
    ).join("\n");
    const out = await fulfillEmailBlocks({ content: blocks, send });
    expect(send).toHaveBeenCalledTimes(MAX_EMAILS_PER_TURN);
    expect(out.content).toContain("at most");
  });

  it("collapses a thrown sender into a failed outcome (never throws)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("smtp down"));
    const out = await fulfillEmailBlocks({
      content: block('{"to": "a@b.co", "subject": "s", "body": "b"}'),
      send
    });
    expect(out.failedCount).toBe(1);
    expect(out.content).toContain("smtp down");
  });

  it("tolerates a non-Error thrown sender and a detail-less failure", async () => {
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw "string failure";
      })
      .mockResolvedValueOnce({ ok: false });
    const content = [
      block('{"to": "a@b.co", "subject": "s", "body": "b"}'),
      block('{"to": "c@d.co", "subject": "s", "body": "b"}')
    ].join("\n");
    const out = await fulfillEmailBlocks({ content, send });
    expect(out.failedCount).toBe(2);
    expect(out.content).toContain("send_failed");
  });

  it("reports invalid blocks even when no valid ones exist", async () => {
    const send = vi.fn();
    const out = await fulfillEmailBlocks({ content: block("not json"), send });
    expect(send).not.toHaveBeenCalled();
    expect(out.failedCount).toBe(1);
    expect(out.content).toContain("malformed");
  });
});
