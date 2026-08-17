import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));
vi.mock("@/lib/admin/view-as", () => ({
  resolveViewAsTargetUser: vi.fn()
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
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
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
  vi.mocked(resolveViewAsTargetUser).mockImplementation(async (u) => ({
    userId: u.userId,
    email: u.email,
    impersonating: false
  }));
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

  it("REFUSES under view-as: consent cannot be recorded for a tenant", async () => {
    // The one view-as refusal left in the product, and it is policy rather
    // than a wrong-row hazard. Every other tenant-facing write retargets to
    // the impersonated owner; this one must not, because a terms_acceptances
    // row evidences that a specific person agreed. An operator-recorded row
    // would be fabricated consent however it were labeled, so the capability
    // does not exist rather than existing-but-marked (a labeled
    // 'admin_view_as' source shipped briefly in PR #1420 and was withdrawn).
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "admin-1", email: "a@x.co" } as never);
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "u-tenant",
      email: "tenant@example.com",
      impersonating: true
    });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(403);
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("still records normally for the admin's OWN login (self-owned view-as)", async () => {
    // selfOwned impersonation resolves impersonating:false, so the admin
    // accepting for the HQ tenant they personally own is their own consent and
    // must keep working.
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "admin-1", email: "a@x.co" } as never);
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "admin-1",
      email: "a@x.co",
      impersonating: false
    });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(recordAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-1", source: "gate" })
    );
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
