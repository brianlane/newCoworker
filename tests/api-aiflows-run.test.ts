import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/ai-flows/db", () => ({
  getAiFlow: vi.fn(),
  enqueueAiFlowRun: vi.fn()
}));

import { POST } from "@/app/api/aiflows/[id]/run/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { enqueueAiFlowRun, getAiFlow } from "@/lib/ai-flows/db";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";
const FLOW = "22222222-2222-4222-8222-222222222222";

function req(body?: unknown) {
  return new Request(`http://localhost/api/aiflows/${FLOW}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
}

function ctx(id = FLOW) {
  return { params: Promise.resolve({ id }) };
}

describe("api/aiflows/[id]/run route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireOwner).mockResolvedValue(OWNER as never);
    vi.mocked(getAiFlow).mockResolvedValue({ id: FLOW, enabled: true } as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue({ id: "run-1", status: "queued" } as never);
  });

  it("401 when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(req({ businessId: BIZ }), ctx());
    expect(res.status).toBe(401);
  });

  it("400 on a non-uuid flow id", async () => {
    const res = await POST(req({ businessId: BIZ }), ctx("nope"));
    expect(res.status).toBe(400);
  });

  it("400 on a missing businessId", async () => {
    const res = await POST(req({}), ctx());
    expect(res.status).toBe(400);
  });

  it("404 when the flow does not exist for this business", async () => {
    vi.mocked(getAiFlow).mockResolvedValue(null);
    const res = await POST(req({ businessId: BIZ }), ctx());
    expect(res.status).toBe(404);
  });

  it("400 when the flow is disabled (the worker would just cancel the run)", async () => {
    vi.mocked(getAiFlow).mockResolvedValue({ id: FLOW, enabled: false } as never);
    const res = await POST(req({ businessId: BIZ }), ctx());
    expect(res.status).toBe(400);
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("enqueues with a manual trigger scope built from the input", async () => {
    const res = await POST(
      req({ businessId: BIZ, input: "look at https://x.com/lead please" }),
      ctx()
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(requireOwner).toHaveBeenCalledWith(BIZ);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        flowId: FLOW,
        trigger: expect.objectContaining({
          channel: "manual",
          url: "https://x.com/lead",
          windowText: "look at https://x.com/lead please",
          from: OWNER.email
        }),
        dedupeKey: expect.stringMatching(/^manual:/)
      })
    );
  });

  it("admin bypasses requireOwner; empty input yields an empty scope", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    const res = await POST(req({ businessId: BIZ }), ctx());
    expect(res.status).toBe(200);
    expect(requireOwner).not.toHaveBeenCalled();
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ windowText: "", url: null })
      })
    );
  });
});
