import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(false)
}));

import { POST } from "@/app/api/internal/meter-gemini-spend/route";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";

const VALID_BIZ = "00000000-0000-4000-8000-000000000001";

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/internal/meter-gemini-spend", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    })
  );
}

const validBody = {
  businessId: VALID_BIZ,
  model: "gemini-2.5-flash-lite",
  usage: { promptTokens: 1200, outputTokens: 340 }
};

describe("POST /api/internal/meter-gemini-spend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
  });

  it("401s when the gateway token is not bound to the posted business", async () => {
    const res = await post(validBody, { Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(meterGeminiSpendForBusiness).not.toHaveBeenCalled();
  });

  it("meters the exact usage against the vps_rowboat surface on a valid token", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    const res = await post(validBody, { Authorization: "Bearer per-tenant" });
    expect(res.status).toBe(200);
    expect(verifyGatewayTokenForBusiness).toHaveBeenCalledWith(expect.anything(), VALID_BIZ);
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith({
      businessId: VALID_BIZ,
      model: "gemini-2.5-flash-lite",
      surface: "vps_rowboat",
      usage: { promptTokens: 1200, outputTokens: 340 }
    });
  });

  it("accepts and forwards the optional Gemini Live audio token split", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    const body = {
      businessId: VALID_BIZ,
      model: "gemini-3.1-flash-live-preview",
      usage: {
        promptTokens: 10_000,
        outputTokens: 20_000,
        promptAudioTokens: 9_000,
        outputAudioTokens: 19_500
      }
    };
    const res = await post(body, { Authorization: "Bearer per-tenant" });
    expect(res.status).toBe(200);
    expect(meterGeminiSpendForBusiness).toHaveBeenCalledWith({
      businessId: VALID_BIZ,
      model: "gemini-3.1-flash-live-preview",
      surface: "vps_rowboat",
      usage: {
        promptTokens: 10_000,
        outputTokens: 20_000,
        promptAudioTokens: 9_000,
        outputAudioTokens: 19_500
      }
    });
  });

  it("400s on a negative audio token count", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    const res = await post(
      {
        businessId: VALID_BIZ,
        model: "gemini-3.1-flash-live-preview",
        usage: { promptTokens: 10, outputTokens: 10, promptAudioTokens: -1 }
      },
      { Authorization: "Bearer per-tenant" }
    );
    expect(res.status).toBe(400);
    expect(meterGeminiSpendForBusiness).not.toHaveBeenCalled();
  });

  it("400s on an invalid body (and never meters)", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    const res = await post(
      { businessId: "not-a-uuid", model: "", usage: { promptTokens: -1, outputTokens: 0 } },
      { Authorization: "Bearer per-tenant" }
    );
    expect(res.status).toBe(400);
    expect(meterGeminiSpendForBusiness).not.toHaveBeenCalled();
  });
});
