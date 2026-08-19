import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn()
}));

import { POST } from "@/app/api/auth/signout/route";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VIEW_AS_COOKIE } from "@/lib/admin/view-as";

function mockAuth(email: string | null) {
  const signOut = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: email ? { email } : null } }),
      signOut
    }
  } as never);
  return { signOut };
}

/** POST with an optional form body, the way the browser submits it. */
function signoutRequest(reason?: string): NextRequest {
  const body = new FormData();
  if (reason !== undefined) body.set("reason", reason);
  return new NextRequest("http://localhost:3000/api/auth/signout", {
    method: "POST",
    ...(reason === undefined ? {} : { body })
  });
}

describe("api/auth/signout route", () => {
  const originalAdmin = process.env.ADMIN_EMAIL;

  afterAll(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = originalAdmin;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAIL = "boss@newcoworker.com";
    mockAuth("owner@example.com");
  });

  it("revokes the session and lands on /login", async () => {
    const { signOut } = mockAuth("owner@example.com");
    const res = await POST(signoutRequest());
    expect(signOut).toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("sends an admin to /admin/login", async () => {
    mockAuth("boss@newcoworker.com");
    const res = await POST(signoutRequest());
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin/login");
  });

  it("carries the idle-timeout reason so the login page can explain itself", async () => {
    const res = await POST(signoutRequest("session_timeout"));
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/login?error=session_timeout"
    );
  });

  it("IGNORES any reason it does not recognize, rather than reflecting it", async () => {
    // The whole point of the whitelist: this value reaches a redirect URL.
    for (const hostile of [
      "https://evil.com",
      "../../admin",
      "session_timeout%20extra",
      "<script>alert(1)</script>",
      "no_account"
    ]) {
      const res = await POST(signoutRequest(hostile));
      expect(res.headers.get("location")).toBe("http://localhost:3000/login");
    }
  });

  it("still signs out when there is no form body at all", async () => {
    const { signOut } = mockAuth("owner@example.com");
    const res = await POST(signoutRequest());
    expect(signOut).toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("clears the admin view-as cookie", async () => {
    const res = await POST(signoutRequest());
    const cookie = res.cookies.get(VIEW_AS_COOKIE);
    expect(cookie?.value).toBe("");
  });
});
