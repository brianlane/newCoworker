import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn()
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/auth/callback/route";

describe("api/auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null })
      }
    } as never);
  });

  it("redirects to safe relative path and preserves query params", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=abc&redirectTo=%2Fonboard%2Fquestionnaire%3Ftier%3Dstandard"
    );
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/onboard/questionnaire?tier=standard");
  });

  it("falls back to dashboard for absolute external redirectTo", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=abc&redirectTo=https%3A%2F%2Fevil.com"
    );
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("falls back to dashboard for protocol-relative redirectTo", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auth/callback?code=abc&redirectTo=%2F%2Fevil.com"
    );
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });
});
