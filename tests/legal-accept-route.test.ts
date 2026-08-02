import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));
vi.mock("@/lib/admin/view-as", () => ({
  isViewAsActive: vi.fn()
}));
vi.mock("@/lib/legal/acceptance", () => ({
  recordAcceptance: vi.fn()
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitDurable: vi.fn(),
  rateLimitIdentifierFromRequest: vi.fn()
}));

import { POST } from "@/app/api/legal/accept/route";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { recordAcceptance } from "@/lib/legal/acceptance";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/legal/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "TestBrowser/1.0" },
    body: body === undefined ? "not-json" : JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(null);
  vi.mocked(isViewAsActive).mockResolvedValue(false);
  vi.mocked(recordAcceptance).mockResolvedValue();
  vi.mocked(rateLimitDurable).mockResolvedValue({ success: true } as never);
  vi.mocked(rateLimitIdentifierFromRequest).mockReturnValue("203.0.113.9");
});

describe("POST /api/legal/accept", () => {
  it("records a gate acceptance for a signed-in user", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u-1",
      email: "owner@example.com"
    } as never);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(recordAcceptance).toHaveBeenCalledWith({
      userId: "u-1",
      email: "owner@example.com",
      source: "gate",
      ip: "203.0.113.9",
      userAgent: "TestBrowser/1.0"
    });
    // Authenticated path never consumes the unauth rate budget.
    expect(rateLimitDurable).not.toHaveBeenCalled();
  });

  it("refuses under admin view-as (no fabricated tenant consent)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "admin-1", email: "a@x.co" } as never);
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(403);
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("records a pre-session signup acceptance keyed by email", async () => {
    const res = await POST(makeRequest({ email: "new@example.com" }));
    expect(res.status).toBe(200);
    expect(rateLimitDurable).toHaveBeenCalledWith(
      "legal-accept:203.0.113.9",
      expect.objectContaining({ maxRequests: 20 })
    );
    expect(recordAcceptance).toHaveBeenCalledWith({
      email: "new@example.com",
      source: "signup",
      ip: "203.0.113.9",
      userAgent: "TestBrowser/1.0"
    });
  });

  it("rejects an anonymous call with no email", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("tolerates a non-JSON body (treated as empty)", async () => {
    const res = await POST(makeRequest(undefined));
    expect(res.status).toBe(401);
  });

  it("429s the unauth path once the per-IP budget is exhausted", async () => {
    vi.mocked(rateLimitDurable).mockResolvedValue({ success: false } as never);
    const res = await POST(makeRequest({ email: "new@example.com" }));
    expect(res.status).toBe(429);
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("rejects a malformed email with a validation error", async () => {
    const res = await POST(makeRequest({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("routes unexpected failures through the shared handler", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u-1", email: "o@x.co" } as never);
    vi.mocked(recordAcceptance).mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
  });
});
