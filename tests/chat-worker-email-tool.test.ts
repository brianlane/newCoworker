import { describe, it, expect, vi } from "vitest";
import {
  EMAIL_SEND_OPEN,
  EMAIL_SEND_CLOSE,
  MAX_EMAILS_PER_TURN,
  extractEmailSendRequests,
  describeEmailOutcome,
  appendEmailResults,
  postEmailSend,
  fulfillEmailSends
} from "../vps/chat-worker/email-tool.mjs";

const BIZ = "11111111-1111-4111-8111-111111111111";

function block(json: string): string {
  return `${EMAIL_SEND_OPEN}\n${json}\n${EMAIL_SEND_CLOSE}`;
}

const VALID_JSON = `{"to": "lead@example.com", "subject": "Hello", "body": "Hi there"}`;

describe("extractEmailSendRequests", () => {
  it("passes content without markers through unchanged", () => {
    const out = extractEmailSendRequests("just a normal reply");
    expect(out).toEqual({ cleanedContent: "just a normal reply", requests: [], invalidCount: 0 });
  });

  it("tolerates non-string content", () => {
    expect(extractEmailSendRequests(null).requests).toEqual([]);
    expect(extractEmailSendRequests(undefined).cleanedContent).toBe("");
  });

  it("parses a valid block and strips it from the visible reply", () => {
    const content = `Sending it now.\n\n${block(VALID_JSON)}\n\nAnything else?`;
    const out = extractEmailSendRequests(content);
    expect(out.requests).toEqual([
      { to: "lead@example.com", subject: "Hello", body: "Hi there", cc: [], bcc: [] }
    ]);
    expect(out.invalidCount).toBe(0);
    expect(out.cleanedContent).not.toContain(EMAIL_SEND_OPEN);
    expect(out.cleanedContent).not.toContain("lead@example.com");
    expect(out.cleanedContent).toContain("Sending it now.");
    expect(out.cleanedContent).toContain("Anything else?");
  });

  it("strips code fences the model wraps around the block", () => {
    const content = "Sure.\n\n```json\n" + block(VALID_JSON) + "\n```\n\nDone.";
    const out = extractEmailSendRequests(content);
    expect(out.requests).toHaveLength(1);
    expect(out.cleanedContent).not.toContain("```");
  });

  it("accepts the adapter alias field names (toEmail/bodyText)", () => {
    const content = block(`{"toEmail": "a@b.co", "subject": "S", "bodyText": "B"}`);
    const out = extractEmailSendRequests(content);
    expect(out.requests).toEqual([{ to: "a@b.co", subject: "S", body: "B", cc: [], bcc: [] }]);
  });

  it("parses cc/bcc from arrays or CSV, lowercasing and dropping invalid entries", () => {
    const arr = block(
      `{"to": "a@b.co", "subject": "S", "body": "B", "cc": ["CC@x.com", "nope"], "bcc": "d@x.com, e@x.com"}`
    );
    const out = extractEmailSendRequests(arr);
    expect(out.requests).toEqual([
      { to: "a@b.co", subject: "S", body: "B", cc: ["cc@x.com"], bcc: ["d@x.com", "e@x.com"] }
    ]);
  });

  it("counts malformed JSON as invalid without surfacing it", () => {
    const content = `Before\n${block("{not json")}\nAfter`;
    const out = extractEmailSendRequests(content);
    expect(out.requests).toEqual([]);
    expect(out.invalidCount).toBe(1);
    expect(out.cleanedContent).not.toContain("{not json");
  });

  it("rejects invalid recipients, blank/oversize subjects and bodies", () => {
    const cases = [
      `{"to": "nope", "subject": "S", "body": "B"}`,
      `{"to": "a@b.co", "subject": "", "body": "B"}`,
      `{"to": "a@b.co", "subject": "${"x".repeat(151)}", "body": "B"}`,
      `{"to": "a@b.co", "subject": "S", "body": ""}`,
      `{"to": "a@b.co", "subject": "S", "body": "${"y".repeat(4001)}"}`,
      `["array"]`
    ];
    for (const json of cases) {
      const out = extractEmailSendRequests(block(json));
      expect(out.requests, json).toEqual([]);
      expect(out.invalidCount, json).toBe(1);
    }
  });

  it("extracts multiple blocks in order", () => {
    const content =
      block(`{"to": "one@x.co", "subject": "1", "body": "a"}`) +
      "\nmiddle\n" +
      block(`{"to": "two@x.co", "subject": "2", "body": "b"}`);
    const out = extractEmailSendRequests(content);
    expect(out.requests.map((r) => r.to)).toEqual(["one@x.co", "two@x.co"]);
    expect(out.cleanedContent).toBe("middle");
  });

  it("truncates a dangling OPEN marker (cut-off generation) so half a JSON object never reaches the owner", () => {
    const content = `Sending now.\n${EMAIL_SEND_OPEN}\n{"to": "a@b.co", "subj`;
    const out = extractEmailSendRequests(content);
    expect(out.cleanedContent).toBe("Sending now.");
    expect(out.invalidCount).toBe(1);
    expect(out.requests).toEqual([]);
  });
});

describe("describeEmailOutcome / appendEmailResults", () => {
  it("renders an honest sent line", () => {
    const line = describeEmailOutcome({ ok: true, to: "a@b.co", subject: "Hi" });
    expect(line).toBe(`Email to a@b.co ("Hi"): sent from your connected mailbox.`);
  });

  it("maps adapter details to owner-actionable failures", () => {
    expect(describeEmailOutcome({ ok: false, to: "a@b.co", subject: "Hi", detail: "tool_disabled" })).toContain(
      "Settings → Coworker tools"
    );
    expect(
      describeEmailOutcome({ ok: false, to: "a@b.co", subject: "Hi", detail: "email_not_connected" })
    ).toContain("Integrations");
    expect(describeEmailOutcome({ ok: false, to: "a@b.co", subject: "Hi", detail: "not_configured" })).toContain(
      "isn't configured"
    );
    expect(
      describeEmailOutcome({ ok: false, to: "a@b.co", subject: "Hi", detail: "too_many_emails" })
    ).toContain(String(MAX_EMAILS_PER_TURN));
    expect(describeEmailOutcome({ ok: false, to: "a@b.co", subject: "Hi", detail: "http_502" })).toContain(
      "http_502"
    );
  });

  it("appendEmailResults leaves the reply alone when there are no results", () => {
    expect(appendEmailResults("reply", [])).toBe("reply");
  });

  it("appendEmailResults separates the reply and the result lines", () => {
    const out = appendEmailResults("reply", [
      { ok: true, to: "a@b.co", subject: "Hi" },
      { ok: false, to: "c@d.co", subject: "Yo", detail: "email_not_connected" }
    ]);
    expect(out).toContain("reply");
    expect(out).toContain("---");
    expect(out).toContain('Email to a@b.co ("Hi"): sent');
    expect(out).toContain("Email to c@d.co");
  });

  it("appendEmailResults works when the cleaned reply is empty (block-only reply)", () => {
    const out = appendEmailResults("", [{ ok: true, to: "a@b.co", subject: "Hi" }]);
    expect(out.startsWith("Email to a@b.co")).toBe(true);
  });
});

describe("postEmailSend", () => {
  const request = { to: "a@b.co", subject: "Hi", body: "Yo" };

  it("POSTs the gateway envelope and maps ok:true", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} })));
    const out = await postEmailSend({
      url: "https://app/api/voice/tools/dashboard-email",
      bearer: "gw",
      businessId: BIZ,
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out).toEqual({ ok: true, to: "a@b.co", subject: "Hi" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app/api/voice/tools/dashboard-email");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw");
    expect(JSON.parse(String(init.body))).toEqual({
      businessId: BIZ,
      args: { toEmail: "a@b.co", subject: "Hi", bodyText: "Yo" }
    });
  });

  it("includes cc/bcc in the args when the request carries them", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} })));
    await postEmailSend({
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      request: { ...request, cc: ["cc@x.com"], bcc: ["bcc@x.com"] },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).args).toEqual({
      toEmail: "a@b.co",
      subject: "Hi",
      bodyText: "Yo",
      cc: ["cc@x.com"],
      bcc: ["bcc@x.com"]
    });
  });

  it("maps an adapter failure detail through", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, detail: "tool_disabled" }))
    );
    const out = await postEmailSend({
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toBe("tool_disabled");
  });

  it("maps a non-JSON / non-2xx response to http_<status>", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const out = await postEmailSend({
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out).toMatchObject({ ok: false, detail: "http_502" });
  });

  it("never throws on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const out = await postEmailSend({
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out).toMatchObject({ ok: false, detail: "adapter_unreachable" });
  });
});

describe("fulfillEmailSends", () => {
  it("returns the reply untouched (and makes no HTTP call) when there are no blocks", async () => {
    const fetchImpl = vi.fn();
    const out = await fulfillEmailSends({
      content: "plain reply",
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out).toEqual({ content: "plain reply", sentCount: 0, failedCount: 0, invalidCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a valid block and appends the honest sent line", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} })));
    const out = await fulfillEmailSends({
      content: `On it.\n${block(VALID_JSON)}`,
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.sentCount).toBe(1);
    expect(out.content).toContain("On it.");
    expect(out.content).toContain('Email to lead@example.com ("Hello"): sent');
    expect(out.content).not.toContain(EMAIL_SEND_OPEN);
  });

  it("reports tool_disabled honestly when the adapter rejects", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, detail: "tool_disabled" }))
    );
    const out = await fulfillEmailSends({
      content: block(VALID_JSON),
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(out.sentCount).toBe(0);
    expect(out.failedCount).toBe(1);
    expect(out.content).toContain("NOT sent");
    expect(out.content).toContain("Settings → Coworker tools");
  });

  it("resolves to not_configured (no HTTP call) when the worker has no adapter URL", async () => {
    const fetchImpl = vi.fn();
    const out = await fulfillEmailSends({
      content: block(VALID_JSON),
      url: "",
      bearer: "gw",
      businessId: BIZ,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.content).toContain("isn't configured");
  });

  it("caps sends at MAX_EMAILS_PER_TURN and reports the overflow honestly", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const blocks = Array.from({ length: MAX_EMAILS_PER_TURN + 1 }, (_, i) =>
      block(`{"to": "n${i}@x.co", "subject": "S${i}", "body": "B"}`)
    ).join("\n");
    const out = await fulfillEmailSends({
      content: blocks,
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_EMAILS_PER_TURN);
    expect(out.sentCount).toBe(MAX_EMAILS_PER_TURN);
    expect(out.content).toContain(`at most ${MAX_EMAILS_PER_TURN} emails per reply`);
  });

  it("renders an honest malformed-request line for invalid blocks", async () => {
    const fetchImpl = vi.fn();
    const out = await fulfillEmailSends({
      content: block("{nope"),
      url: "u",
      bearer: "gw",
      businessId: BIZ,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.invalidCount).toBe(1);
    expect(out.content).toContain("malformed");
  });
});
