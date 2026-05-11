import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockReturnValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60000 }),
  RATE_LIMITS: {
    AUTH: { interval: 900_000, maxRequests: 5 },
    API: { interval: 60_000, maxRequests: 60 },
    WEBHOOK: { interval: 60_000, maxRequests: 100 },
  }
}));

import { createServerClient } from "@supabase/ssr";
import { rateLimit } from "@/lib/rate-limit";
import { proxy } from "../src/proxy";

function makeRequest(
  pathname: string,
  options?: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string> },
): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const req = new NextRequest(url, {
    method: options?.method,
    headers: options?.headers,
  });
  if (options?.cookies) {
    for (const [name, value] of Object.entries(options.cookies)) {
      req.cookies.set(name, value);
    }
  }
  return req;
}

function mockSupabaseWithUser(user: Record<string, unknown> | null) {
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
  };
  vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
    const cookieFns = options?.cookies as { getAll?: () => unknown } | undefined;
    cookieFns?.getAll?.();
    return client as never;
  });
  return client;
}

describe("proxy", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock_anon_key",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      ADMIN_EMAIL: "admin@newcoworker.com"
    };
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60000 });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  // --- CSRF protection ---

  it("blocks POST to /api without origin header", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", { method: "POST" });
    const res = await proxy(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe("CSRF validation failed");
  });

  it("allows POST to /api with valid origin", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows POST when Origin matches Host even if NEXT_PUBLIC_APP_URL differs (e.g. preview)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com";
    delete process.env.VERCEL_URL;
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: {
        origin: "https://preview-branch-xyz.vercel.app",
        host: "preview-branch-xyz.vercel.app",
        "x-forwarded-proto": "https",
      },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows POST from 127.0.0.1 when Host is localhost (loopback normalization)", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "localhost:3000",
      },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows POST to /api with Vercel URL origin", async () => {
    process.env.VERCEL_URL = "my-app.vercel.app";
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: { origin: "https://my-app.vercel.app" },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows POST to /api/webhooks without origin (skip CSRF)", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/webhooks/stripe", { method: "POST" });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows POST to /api/rowboat without origin (token-authed external route)", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/rowboat", { method: "POST" });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows GET to /api without origin (CSRF only for state-changing)", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/business/status");
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("validates referer when origin is absent", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: { referer: "http://localhost:3000/onboard" },
    });
    const res = await proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("rejects POST with mismatched origin", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: { origin: "https://evil-site.com" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(403);
  });

  it("uses Vercel fallback and still rejects wrong origin", async () => {
    process.env.VERCEL_URL = "my-app.vercel.app";
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(403);
  });

  // --- Rate limiting ---

  it("returns 429 when rate limit exceeded", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 60000 });
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/test");
    const res = await proxy(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("uses AUTH rate limit for POST /login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/login", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    await proxy(req);
    expect(rateLimit).toHaveBeenCalledWith(expect.stringContaining("auth"), expect.objectContaining({ maxRequests: 5 }));
  });

  it("uses WEBHOOK rate limit for /api/webhooks", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/webhooks/stripe", { method: "POST" });
    await proxy(req);
    expect(rateLimit).toHaveBeenCalledWith(expect.stringContaining("webhook"), expect.objectContaining({ maxRequests: 100 }));
  });

  // --- Session / Auth ---

  it("allows unauthenticated access to public routes", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/onboard");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });

  it("returns response when env vars missing (no supabase)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const req = makeRequest("/about");
    const res = await proxy(req);
    expect(res).toBeInstanceOf(NextResponse);
  });

  it("redirects unauthenticated user from /dashboard to /login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/dashboard");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(decodeURIComponent(location)).toContain("redirectTo=/dashboard");
  });

  it("allows unauthenticated user to access questionnaire", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/onboard/questionnaire?tier=starter");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated user to access /onboard/success (post-payment landing)", async () => {
    // Stripe redirects back here with `?session_id=` BEFORE the user has
    // created their password. /api/onboard/finalize-signup verifies the
    // Stripe-signed session id, and /api/onboard/set-password mints the
    // auth user. Both run before any session cookie exists.
    mockSupabaseWithUser(null);
    const req = makeRequest("/onboard/success?session_id=cs_test_abc");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });

  it("redirects unauthenticated user from /admin to /admin/login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/admin");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("redirects non-admin from /admin to /admin/login", async () => {
    mockSupabaseWithUser({ id: "u-1", email: "notadmin@test.com" });
    const req = makeRequest("/admin");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("allows admin to access /admin", async () => {
    mockSupabaseWithUser({ id: "admin-1", email: "admin@newcoworker.com" });
    const req = makeRequest("/admin");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });

  it("redirects authenticated admin away from /admin/login to /admin", async () => {
    mockSupabaseWithUser({ id: "admin-1", email: "admin@newcoworker.com" });
    const req = makeRequest("/admin/login");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin");
  });

  it("allows unauthenticated access to /admin/login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/admin/login");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });

  it("redirects when ADMIN_EMAIL not set and user tries /admin", async () => {
    delete process.env.ADMIN_EMAIL;
    mockSupabaseWithUser({ id: "u-1", email: "user@test.com" });
    const req = makeRequest("/admin");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("redirects admin users from /dashboard to /admin", async () => {
    mockSupabaseWithUser({ id: "admin-1", email: "admin@newcoworker.com" });
    const req = makeRequest("/dashboard");
    const res = await proxy(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin");
  });

  it("allows authenticated non-admin to access /dashboard", async () => {
    mockSupabaseWithUser({ id: "u-1", email: "user@test.com" });
    const req = makeRequest("/dashboard");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });

  it("invokes cookie getAll and setAll handlers", async () => {
    let getAllCalled = false;
    let setAllCalled = false;
    vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
      const cookies = options?.cookies as {
        getAll?: () => unknown;
        setAll?: (rows: { name: string; value: string; options?: Record<string, unknown> }[]) => void;
      };
      cookies?.getAll?.();
      getAllCalled = true;
      cookies?.setAll?.([
        { name: "sb-token", value: "x", options: { path: "/" } },
        { name: "sb-token", value: "", options: { path: "/", maxAge: 0 } },
      ]);
      setAllCalled = true;
      return {
        auth: {
          getUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "u-1", email: "user@test.com" } }, error: null }),
        },
      } as never;
    });

    const req = makeRequest("/dashboard");
    await proxy(req);
    expect(getAllCalled).toBe(true);
    expect(setAllCalled).toBe(true);
  });

  it("handles invalid URLs in origin matching gracefully", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/api/checkout", {
      method: "POST",
      headers: { origin: "not-a-url" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(403);
  });

  it("does not redirect non-admin from /admin/login", async () => {
    mockSupabaseWithUser({ id: "u-1", email: "user@test.com" });
    const req = makeRequest("/admin/login");
    const res = await proxy(req);
    expect(res.status).toBe(200);
  });
});
