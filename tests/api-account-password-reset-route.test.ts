import { beforeEach, describe, expect, it, vi } from "vitest";

const resetPasswordForEmail = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { resetPasswordForEmail } }))
}));
vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/admin/view-as", () => ({ resolveViewAsTargetUser: vi.fn() }));
vi.mock("@/lib/dashboard/active-business", () => ({ resolveActiveBusinessId: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/supabase/env", () => ({
  readSupabaseEnv: vi.fn(() => ({ url: "https://x.supabase.co", anonKey: "anon-key" }))
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimitDurable: vi.fn() }));

import { POST } from "@/app/api/account/password-reset/route";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { logAdminAction } from "@/lib/admin/audit";
import { rateLimitDurable } from "@/lib/rate-limit";

/**
 * An operator sending a locked-out tenant their own reset link.
 *
 * The design point every assertion here defends: this is a RESET, not a set.
 * The tenant picks the new password from their own inbox, so the operator
 * never holds a live customer credential and never has to read one out on a
 * support call.
 */

function request(): Request {
  return new Request("https://app.example/api/account/password-reset", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    userId: "u-admin",
    email: "admin@newcoworker.com",
    isAdmin: true
  } as never);
  vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
    userId: "u-tenant",
    email: "tenant@example.com",
    impersonating: true
  });
  vi.mocked(resolveActiveBusinessId).mockResolvedValue("biz-1");
  vi.mocked(rateLimitDurable).mockResolvedValue({ success: true } as never);
  resetPasswordForEmail.mockResolvedValue({ error: null });
});

describe("POST /api/account/password-reset", () => {
  it("sends the tenant's own recovery email and audits the operator action", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { sentTo: "tenant@example.com" } });

    // The TENANT's address, and the same /reset-password landing the public
    // forgot-password flow uses.
    expect(resetPasswordForEmail).toHaveBeenCalledWith("tenant@example.com", {
      redirectTo: "https://app.example/api/auth/callback?redirectTo=%2Freset-password"
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminEmail: "admin@newcoworker.com",
        action: "tenant_password_reset_sent",
        businessId: "biz-1"
      })
    );
  });

  it("refuses when the caller is not impersonating", async () => {
    // An owner changing their own password uses the Account card; a signed-out
    // one uses /login. This route stays a narrow operator surface.
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "u-owner",
      email: "owner@example.com",
      impersonating: false
    });
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("404s when the impersonated tenant has no login", async () => {
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: null,
      email: "pending-x@example.com",
      impersonating: true
    });
    const res = await POST(request());
    expect(res.status).toBe(404);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("rate limits per TARGET so a mis-clicking operator cannot flood an inbox", async () => {
    vi.mocked(rateLimitDurable).mockResolvedValue({ success: false } as never);
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(rateLimitDurable).toHaveBeenCalledWith(
      "account-password-reset:tenant@example.com",
      expect.objectContaining({ maxRequests: 5 })
    );
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("surfaces a Supabase send failure instead of reporting success", async () => {
    resetPasswordForEmail.mockResolvedValue({ error: { message: "rate limited upstream" } });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it("still reports success when only the audit write fails", async () => {
    // The email is already out; a logging hiccup must not make an operator
    // retry an action that landed.
    vi.mocked(resolveActiveBusinessId).mockRejectedValue(new Error("db down"));
    const res = await POST(request());
    expect(res.status).toBe(200);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await POST(request())).status).toBe(401);
  });
});
