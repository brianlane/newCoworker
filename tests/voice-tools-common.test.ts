import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolEnvelopeSchema,
  voiceToolResponse,
  voiceToolUnauthorized,
  voiceToolValidationError
} from "@/lib/voice-tools/common";

function makeRequest(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/voice/tools/test", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

describe("voiceToolEnvelopeSchema", () => {
  const businessId = "11111111-1111-4111-8111-111111111111";

  it("defaults args to an empty object", () => {
    const parsed = voiceToolEnvelopeSchema.parse({ businessId });
    expect(parsed.args).toEqual({});
  });

  it("requires a uuid businessId and keeps call metadata", () => {
    expect(() => voiceToolEnvelopeSchema.parse({ businessId: "not-a-uuid" })).toThrow();
    const parsed = voiceToolEnvelopeSchema.parse({
      businessId,
      callControlId: "cc_1",
      callerE164: "+15555550100",
      args: { foo: 1 }
    });
    expect(parsed.callControlId).toBe("cc_1");
    expect(parsed.callerE164).toBe("+15555550100");
    expect(parsed.args).toEqual({ foo: 1 });
  });
});

describe("gatewayGuard + response helpers", () => {
  const OLD = process.env;

  beforeEach(() => {
    process.env = { ...OLD, ROWBOAT_GATEWAY_TOKEN: "gw" };
  });

  afterEach(() => {
    process.env = OLD;
  });

  it("returns 401 when the bearer is missing or wrong", async () => {
    expect(gatewayGuard(new Request("http://localhost/"))).not.toBeNull();
    const wrong = gatewayGuard(
      new Request("http://localhost/", { headers: { authorization: "Bearer bad" } })
    );
    expect(wrong).not.toBeNull();
    expect(wrong!.status).toBe(401);
    const body = await wrong!.json();
    expect(body).toEqual({ ok: false, detail: "unauthorized" });
  });

  it("returns null when the bearer matches", () => {
    const ok = gatewayGuard(
      new Request("http://localhost/", { headers: { authorization: "Bearer gw" } })
    );
    expect(ok).toBeNull();
  });

  it("voiceToolResponse keeps the raw ok/detail/data shape the bridge expects", async () => {
    const res = voiceToolResponse({ ok: false, detail: "email_not_connected" });
    expect(res.status).toBe(200); // bridge treats detail as a model-visible hint, not an HTTP error
    expect(await res.json()).toEqual({ ok: false, detail: "email_not_connected" });
  });

  it("voiceToolValidationError prefixes the zod message", async () => {
    const res = voiceToolValidationError("toEmail required");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe("invalid_args:toEmail required");
  });

  it("voiceToolUnauthorized matches the 401 shape", async () => {
    const res = voiceToolUnauthorized();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, detail: "unauthorized" });
  });
});

describe("parseVoiceToolRequest", () => {
  it("parses and validates the envelope", async () => {
    const req = makeRequest({
      businessId: "11111111-1111-4111-8111-111111111111",
      args: { question: "hi" }
    });
    const parsed = await parseVoiceToolRequest(req);
    expect(parsed.args).toEqual({ question: "hi" });
  });

  it("throws on malformed JSON (empty body parses to {})", async () => {
    const req = new Request("http://localhost/", { method: "POST" });
    await expect(parseVoiceToolRequest(req)).rejects.toThrow();
  });
});
