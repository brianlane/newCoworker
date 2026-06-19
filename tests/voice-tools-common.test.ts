import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

const { verifyForBusinessMock } = vi.hoisted(() => ({ verifyForBusinessMock: vi.fn() }));
vi.mock("@/lib/rowboat/gateway-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rowboat/gateway-token")>();
  return { ...actual, verifyGatewayTokenForBusiness: verifyForBusinessMock };
});

import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolEnvelopeSchema,
  voiceToolResponse,
  voiceToolUnauthorized,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";

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

describe("response helpers", () => {
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

describe("gatewayBusinessGuard", () => {
  const businessId = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => vi.clearAllMocks());

  it("returns null when the token resolves to the business", async () => {
    verifyForBusinessMock.mockResolvedValue(true);
    await expect(
      gatewayBusinessGuard(new Request("http://localhost/"), businessId)
    ).resolves.toBeNull();
    expect(verifyForBusinessMock).toHaveBeenCalledWith(expect.any(Request), businessId);
  });

  it("returns a 401 when the token does not resolve to the business", async () => {
    verifyForBusinessMock.mockResolvedValue(false);
    const res = await gatewayBusinessGuard(new Request("http://localhost/"), businessId);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ ok: false, detail: "unauthorized" });
  });
});

describe("agentToolDisabledResponse", () => {
  const businessId = "11111111-1111-4111-8111-111111111111";

  it("returns null when the tool is enabled", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
    await expect(
      agentToolDisabledResponse(businessId, "voice", "send_follow_up_sms")
    ).resolves.toBeNull();
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      businessId,
      "voice",
      "send_follow_up_sms"
    );
  });

  it("returns a 200 tool_disabled body when the owner turned the tool off", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await agentToolDisabledResponse(businessId, "voice", "send_follow_up_sms");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: false, detail: "tool_disabled" });
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
