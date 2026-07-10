import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 }))
}));

// Keep the real parseLeadBacklog (pure CSV parsing) so the route's parse-error
// path is exercised for real; mock only the enqueue side effect.
vi.mock("@/lib/ai-flows/lead-backlog", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai-flows/lead-backlog")>();
  return { ...mod, importLeadBacklog: vi.fn() };
});

vi.mock("@/lib/ai-flows/webhook-events", () => ({
  countEnabledWebhookFlows: vi.fn()
}));

import { POST } from "@/app/api/dashboard/aiflows/lead-import/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { importLeadBacklog } from "@/lib/ai-flows/lead-backlog";
import { countEnabledWebhookFlows } from "@/lib/ai-flows/webhook-events";

const OWNER = { userId: "u-1", email: "owner@example.com", isAdmin: false };
const BIZ = "11111111-1111-4111-8111-111111111111";
const CSV = "Full Name,Phone\nJane,+16025551234\nBob,+16025555678";
const SUMMARY = {
  totalRows: 2,
  enqueued: 2,
  duplicates: 0,
  unmatched: 0,
  skipped: 0,
  flowsEvaluated: 1,
  rows: []
};

function req(body: unknown, query = `businessId=${BIZ}`): Request {
  return new Request(`http://localhost/api/dashboard/aiflows/lead-import?${query}`, {
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
  vi.mocked(importLeadBacklog).mockResolvedValue(SUMMARY);
  vi.mocked(countEnabledWebhookFlows).mockResolvedValue(1);
});

describe("POST /api/dashboard/aiflows/lead-import", () => {
  it("401s when not signed in", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(req({ csv: CSV }));
    expect(res.status).toBe(401);
    expect(importLeadBacklog).not.toHaveBeenCalled();
  });

  it("400s on a missing/invalid businessId or mode", async () => {
    expect((await POST(req({ csv: CSV }, "businessId=nope"))).status).toBe(400);
    expect((await POST(req({ csv: CSV }, `businessId=${BIZ}&mode=weird`))).status).toBe(400);
  });

  it("requires manage_aiflows on the business for non-admins", async () => {
    await POST(req({ csv: CSV }));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_aiflows");
  });

  it("admin bypasses requireBusinessRole", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    const res = await POST(req({ csv: CSV }));
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
    const res = await POST(req({ csv: CSV }));
    expect(res.status).toBe(429);
    expect(importLeadBacklog).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON body or a missing csv field", async () => {
    expect((await POST(req("not json"))).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ csv: "" }))).status).toBe(400);
  });

  it("413s an oversized csv body", async () => {
    const res = await POST(req({ csv: "h\n" + "x".repeat(1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(importLeadBacklog).not.toHaveBeenCalled();
  });

  it("400s a structurally broken sheet with the parser's message", async () => {
    const res = await POST(req({ csv: 'name\n"broken' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/quote/i);
    expect(importLeadBacklog).not.toHaveBeenCalled();
  });

  it("preview mode returns the parsed shape + enabled webhook flow count without importing", async () => {
    const res = await POST(req({ csv: CSV }, `businessId=${BIZ}&mode=preview`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      headers: ["full_name", "phone"],
      totalRows: 2,
      sampleRows: [
        { full_name: "Jane", phone: "+16025551234" },
        { full_name: "Bob", phone: "+16025555678" }
      ],
      webhookFlowsEnabled: 1
    });
    expect(countEnabledWebhookFlows).toHaveBeenCalledWith(BIZ);
    expect(importLeadBacklog).not.toHaveBeenCalled();
  });

  it("imports the parsed rows with the source + drip options and returns the summary", async () => {
    const res = await POST(req({ csv: CSV, source: "old_sheet", dripIntervalSeconds: 300 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ summary: SUMMARY });
    expect(importLeadBacklog).toHaveBeenCalledWith(
      BIZ,
      [
        { full_name: "Jane", phone: "+16025551234" },
        { full_name: "Bob", phone: "+16025555678" }
      ],
      { source: "old_sheet", dripIntervalSeconds: 300 }
    );
  });

  it("400s an out-of-range dripIntervalSeconds", async () => {
    expect((await POST(req({ csv: CSV, dripIntervalSeconds: -1 }))).status).toBe(400);
    expect((await POST(req({ csv: CSV, dripIntervalSeconds: 3601 }))).status).toBe(400);
  });

  it("500s (generic) when the import throws", async () => {
    vi.mocked(importLeadBacklog).mockRejectedValue(new Error("db down"));
    const res = await POST(req({ csv: CSV }));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
