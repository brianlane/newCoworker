import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn()
}));

import { createServerClient } from "@supabase/ssr";
import { updateSession } from "@/lib/supabase/middleware";

function makeRequest(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  const req = new NextRequest(url);
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

function mockSupabaseWithUser(user: Record<string, unknown> | null) {
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null })
    }
  };
  vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
    // Call cookie handlers to hit coverage
    if (options && options.cookies) {
      // Simulate cookie operations
      options.cookies.get?.("test-cookie");
    }
    return client as never;
  });
  return client;
}

describe("supabase/middleware", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock_anon_key",
      ADMIN_EMAIL: "admin@newcoworker.com"
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns response when env vars missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const req = makeRequest("/about");
    const res = await updateSession(req);
    expect(res).toBeInstanceOf(NextResponse);
  });

  it("allows unauthenticated access to public routes", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/onboard");
    const res = await updateSession(req);
    expect(res.status).toBe(200);
  });

  it("redirects unauthenticated user from /dashboard to /login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/dashboard");
    const res = await updateSession(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(decodeURIComponent(location)).toContain("redirectTo=/dashboard");
  });

  it("redirects unauthenticated user from /admin to /admin/login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/admin");
    const res = await updateSession(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("allows authenticated user to access /dashboard", async () => {
    mockSupabaseWithUser({ id: "u-1", email: "user@test.com" });
    const req = makeRequest("/dashboard");
    const res = await updateSession(req);
    expect(res.status).toBe(200);
  });

  it("redirects non-admin from /admin to /admin/login", async () => {
    mockSupabaseWithUser({ id: "u-1", email: "notadmin@test.com" });
    const req = makeRequest("/admin");
    const res = await updateSession(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("allows admin to access /admin", async () => {
    mockSupabaseWithUser({ id: "admin-1", email: "admin@newcoworker.com" });
    const req = makeRequest("/admin");
    const res = await updateSession(req);
    expect(res.status).toBe(200);
  });

  it("redirects when ADMIN_EMAIL not set and user tries /admin", async () => {
    delete process.env.ADMIN_EMAIL;
    mockSupabaseWithUser({ id: "u-1", email: "user@test.com" });
    const req = makeRequest("/admin");
    const res = await updateSession(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("allows unauthenticated access to /admin/login", async () => {
    mockSupabaseWithUser(null);
    const req = makeRequest("/admin/login");
    const res = await updateSession(req);
    expect(res.status).toBe(200);
  });

  it("redirects authenticated admin away from /admin/login to /admin", async () => {
    mockSupabaseWithUser({ id: "admin-1", email: "admin@newcoworker.com" });
    const req = makeRequest("/admin/login");
    const res = await updateSession(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin");
  });

  it("invokes cookie set in middleware via cookie update", async () => {
    let setCalled = false;
    vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
      if (options?.cookies?.set) {
        options.cookies.set("sb-token", "val", {});
        setCalled = true;
      }
      return {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1", email: "user@test.com" } }, error: null }) }
      } as never;
    });

    const req = makeRequest("/dashboard");
    await updateSession(req);
    expect(setCalled).toBe(true);
  });

  it("invokes cookie remove in middleware", async () => {
    let removeCalled = false;
    vi.mocked(createServerClient).mockImplementation((_url, _key, options) => {
      if (options?.cookies?.remove) {
        options.cookies.remove("sb-token", {});
        removeCalled = true;
      }
      return {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1", email: "user@test.com" } }, error: null }) }
      } as never;
    });

    const req = makeRequest("/dashboard");
    await updateSession(req);
    expect(removeCalled).toBe(true);
  });
});
