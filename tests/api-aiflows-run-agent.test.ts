import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/agents/db", () => ({
  getBusinessAgent: vi.fn(),
  insertAgentRun: vi.fn(),
  patchAgentRun: vi.fn()
}));

vi.mock("@/lib/agents/run", () => ({
  executeAgentRun: vi.fn()
}));

vi.mock("@/lib/agents/save-artifact", () => ({
  saveAgentRunArtifact: vi.fn()
}));

vi.mock("@/lib/ai-flows/doc-source", () => ({
  resolveFlowDocumentSource: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn().mockResolvedValue(undefined)
}));

import { POST } from "@/app/api/aiflows/run-agent/route";
import { getBusinessAgent, insertAgentRun, patchAgentRun } from "@/lib/agents/db";
import { executeAgentRun } from "@/lib/agents/run";
import { recordSystemLog } from "@/lib/db/system-logs";

const businessId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

function makeRequest() {
  return new Request("http://localhost/api/aiflows/run-agent", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gw" },
    body: JSON.stringify({ businessId, agentId, input: "WRITE: PROSPECT\n\nno" })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessAgent).mockResolvedValue({
    id: agentId,
    business_id: businessId,
    name: "Team inbox reply drafter",
    instructions: "draft",
    output_format: "markdown",
    enabled: true,
    created_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:00:00.000Z"
  });
  vi.mocked(insertAgentRun).mockResolvedValue(undefined as never);
  vi.mocked(patchAgentRun).mockResolvedValue(undefined as never);
});

describe("POST /api/aiflows/run-agent transient model failures", () => {
  it("returns 503 when Gemini is still overloaded after the inner retries", async () => {
    vi.mocked(executeAgentRun).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "gemini_http_503:high demand"
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, detail: "model_failed" });
    expect(recordSystemLog).toHaveBeenCalled();
  });

  it("returns 503 for a Gemini 429 so the worker re-queues it", async () => {
    vi.mocked(executeAgentRun).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "gemini_http_429:slow down"
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
  });

  it("returns 503 for any other Gemini 5xx", async () => {
    vi.mocked(executeAgentRun).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "gemini_http_500: boom"
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
  });

  it("keeps a permanent model failure on HTTP 200", async () => {
    vi.mocked(executeAgentRun).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "gemini_http_400:API key not valid"
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: false, detail: "model_failed" });
  });

  it("keeps budget and setup failures on HTTP 200", async () => {
    vi.mocked(executeAgentRun).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "budget_exhausted"
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});
