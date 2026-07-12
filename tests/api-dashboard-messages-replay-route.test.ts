import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 }))
}));

vi.mock("@/lib/ai-flows/db", () => ({
  getAiFlow: vi.fn()
}));

// Keep the real flow-shape guards (pure) so the route's gating is exercised
// for real; mock only the enqueue side effect.
vi.mock("@/lib/sms/replay", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/sms/replay")>();
  return { ...mod, replayInboundSms: vi.fn() };
});

import { POST } from "@/app/api/dashboard/messages/replay/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { getAiFlow } from "@/lib/ai-flows/db";
import { replayInboundSms } from "@/lib/sms/replay";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";
const FLOW = "22222222-2222-4222-8222-222222222222";
const SUMMARY = {
  total: 3,
  enqueued: 1,
  duplicates: 1,
  skipped: 1,
  errors: 0,
  outcomes: []
};

/** A valid replay target: sms trigger + upsert before the send. */
const GOOD_DEFINITION = {
  trigger: { channel: "sms", conditions: [] },
  steps: [{ type: "extract_text" }, { type: "upsert_customer" }, { type: "send_sms" }]
};

function req(body: unknown, query = `businessId=${BIZ}`): Request {
  return new Request(`http://localhost/api/dashboard/messages/replay?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 });
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
  vi.mocked(replayInboundSms).mockResolvedValue(SUMMARY as never);
  vi.mocked(getAiFlow).mockResolvedValue({
    id: FLOW,
    enabled: true,
    definition: GOOD_DEFINITION
  } as never);
});

describe("POST /api/dashboard/messages/replay", () => {
  it("401s when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(401);
    expect(replayInboundSms).not.toHaveBeenCalled();
  });

  it("400s on a missing/invalid businessId", async () => {
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }, "businessId=nope"));
    expect(res.status).toBe(400);
  });

  it("requires manage_aiflows on the business for non-admins", async () => {
    await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_aiflows");
  });

  it("admin bypasses requireBusinessRole", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("429s when the per-business limiter rejects", async () => {
    vi.mocked(rateLimit).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 1000
    });
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(429);
    expect(replayInboundSms).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON body, missing fields, or an out-of-range window", async () => {
    expect((await POST(req("not json"))).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ flowId: FLOW, lookbackHours: 0 }))).status).toBe(400);
    expect((await POST(req({ flowId: FLOW, lookbackHours: 1000 }))).status).toBe(400);
  });

  it("404s when the flow doesn't exist for this business", async () => {
    vi.mocked(getAiFlow).mockResolvedValue(null);
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(404);
    expect(replayInboundSms).not.toHaveBeenCalled();
  });

  it("rejects a disabled flow", async () => {
    vi.mocked(getAiFlow).mockResolvedValue({
      id: FLOW,
      enabled: false,
      definition: GOOD_DEFINITION
    } as never);
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/Enable the flow/);
    expect(replayInboundSms).not.toHaveBeenCalled();
  });

  it("rejects a flow with no sms trigger", async () => {
    vi.mocked(getAiFlow).mockResolvedValue({
      id: FLOW,
      enabled: true,
      definition: { ...GOOD_DEFINITION, trigger: { channel: "tenant_email", conditions: [] } }
    } as never);
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/inbound text/);
    expect(replayInboundSms).not.toHaveBeenCalled();
  });

  it("rejects a flow that reaches out before filing the lead", async () => {
    vi.mocked(getAiFlow).mockResolvedValue({
      id: FLOW,
      enabled: true,
      definition: {
        trigger: { channel: "sms", conditions: [] },
        steps: [{ type: "send_sms" }, { type: "upsert_customer" }]
      }
    } as never);
    const res = await POST(req({ flowId: FLOW, lookbackHours: 24 }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/before saving the lead/);
    expect(replayInboundSms).not.toHaveBeenCalled();
  });

  it("replays and returns the summary", async () => {
    const res = await POST(req({ flowId: FLOW, lookbackHours: 48 }));
    expect(res.status).toBe(200);
    expect(replayInboundSms).toHaveBeenCalledWith(
      BIZ,
      { id: FLOW, definition: GOOD_DEFINITION },
      { lookbackHours: 48 }
    );
    const json = (await res.json()) as { data: { summary: typeof SUMMARY } };
    expect(json.data.summary).toEqual(SUMMARY);
  });
});
