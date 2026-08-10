import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/account/email-change", () => ({
  reconcilePendingEmailChange: vi.fn().mockResolvedValue(undefined)
}));

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/auth/callback/route";

/** A user with an `email` identity always passes the gate untouched. */
const passwordUser = {
  id: "owner-1",
  email: "owner@example.com",
  created_at: new Date().toISOString(),
  identities: [{ provider: "email" }],
  app_metadata: { provider: "email", providers: ["email"] }
};

/** Google-only, minted by the sign-in we are inspecting. */
const freshGoogleUser = {
  id: "orphan-1",
  email: "stranger@gmail.com",
  created_at: new Date().toISOString(),
  identities: [{ provider: "google" }],
  app_metadata: { provider: "google", providers: ["google"] }
};

function mockServerClient(user: unknown = passwordUser) {
  const signOut = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      signOut
    }
  } as never);
  return { signOut };
}

/**
 * Service client stub: `hasAccount` decides whether the business lookup finds
 * a row, so a test only has to say "known address" or not.
 */
function mockServiceClient(hasAccount: boolean) {
  const deleteUser = vi.fn().mockResolvedValue({ error: null });
  const rows = hasAccount ? [{ id: "b1" }] : [];
  const limit = vi.fn().mockResolvedValue({ data: rows, error: null });
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        ilike: () => ({ limit }),
        eq: () => ({ neq: () => ({ limit }) })
      })
    }),
    auth: { admin: { deleteUser } }
  } as never);
  return { deleteUser };
}

function callbackRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/auth/callback?${query}`);
}

describe("api/auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerClient();
    mockServiceClient(true);
  });

  it("redirects to safe relative path and preserves query params", async () => {
    const req = callbackRequest("code=abc&redirectTo=%2Fonboard%2Fquestionnaire%3Ftier%3Dstandard");
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/onboard/questionnaire?tier=standard");
  });

  it("falls back to dashboard for absolute external redirectTo", async () => {
    const res = await GET(callbackRequest("code=abc&redirectTo=https%3A%2F%2Fevil.com"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("falls back to dashboard for protocol-relative redirectTo", async () => {
    const res = await GET(callbackRequest("code=abc&redirectTo=%2F%2Fevil.com"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("skips the gate entirely when there is no code to exchange", async () => {
    const res = await GET(callbackRequest("redirectTo=%2Fdashboard"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  describe("OAuth account gate", () => {
    it("bounces a google sign-in whose address has no account, and deletes the row it minted", async () => {
      const { signOut } = mockServerClient(freshGoogleUser);
      const { deleteUser } = mockServiceClient(false);

      const res = await GET(callbackRequest("code=abc&redirectTo=%2Fdashboard"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=no_account");
      expect(signOut).toHaveBeenCalled();
      expect(deleteUser).toHaveBeenCalledWith("orphan-1");
    });

    it("refuses an older orphan without deleting anything", async () => {
      const { signOut } = mockServerClient({
        ...freshGoogleUser,
        created_at: "2026-08-01T03:24:21.317636Z"
      });
      const { deleteUser } = mockServiceClient(false);

      const res = await GET(callbackRequest("code=abc"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=no_account");
      expect(signOut).toHaveBeenCalled();
      expect(deleteUser).not.toHaveBeenCalled();
    });

    it("still refuses when signOut throws", async () => {
      mockServerClient(freshGoogleUser);
      vi.mocked(createSupabaseServerClient).mockResolvedValue({
        auth: {
          exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
          getUser: vi.fn().mockResolvedValue({ data: { user: freshGoogleUser } }),
          signOut: vi.fn().mockRejectedValue(new Error("revoke down"))
        }
      } as never);
      const { deleteUser } = mockServiceClient(false);

      const res = await GET(callbackRequest("code=abc"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=no_account");
      expect(deleteUser).toHaveBeenCalledWith("orphan-1");
    });

    it("still refuses when the orphan delete fails", async () => {
      mockServerClient(freshGoogleUser);
      const deleteUser = vi.fn().mockResolvedValue({ error: { message: "delete failed" } });
      const limit = vi.fn().mockResolvedValue({ data: [], error: null });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        from: () => ({
          select: () => ({ ilike: () => ({ limit }), eq: () => ({ neq: () => ({ limit }) }) })
        }),
        auth: { admin: { deleteUser } }
      } as never);

      const res = await GET(callbackRequest("code=abc"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=no_account");
      expect(deleteUser).toHaveBeenCalled();
    });

    it("lets a google sign-in through when the address owns a business", async () => {
      const { signOut } = mockServerClient(freshGoogleUser);
      const { deleteUser } = mockServiceClient(true);

      const res = await GET(callbackRequest("code=abc"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
      expect(signOut).not.toHaveBeenCalled();
      expect(deleteUser).not.toHaveBeenCalled();
    });

    it("lets an email-confirmation callback through (no business row yet)", async () => {
      mockServerClient(passwordUser);
      const { deleteUser } = mockServiceClient(false);

      const res = await GET(callbackRequest("code=abc&redirectTo=%2Fonboard"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/onboard");
      expect(deleteUser).not.toHaveBeenCalled();
    });

    it("allows the sign-in when the exchange produced no user", async () => {
      mockServerClient(null);
      const res = await GET(callbackRequest("code=abc"));
      expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    });

    it("fails open when the account lookup throws", async () => {
      mockServerClient(freshGoogleUser);
      const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } });
      const deleteUser = vi.fn();
      vi.mocked(createSupabaseServiceClient).mockResolvedValue({
        from: () => ({
          select: () => ({ ilike: () => ({ limit }), eq: () => ({ neq: () => ({ limit }) }) })
        }),
        auth: { admin: { deleteUser } }
      } as never);

      const res = await GET(callbackRequest("code=abc"));

      expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
      expect(deleteUser).not.toHaveBeenCalled();
    });
  });
});
