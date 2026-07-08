import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: { set: vi.fn(), delete: vi.fn(), get: vi.fn() }
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore)
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/dashboard/active-business", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboard/active-business")>();
  return {
    ...actual,
    listAccessibleBusinesses: vi.fn()
  };
});

import { POST, DELETE } from "@/app/api/dashboard/active-business/route";
import { getAuthUser } from "@/lib/auth";
import {
  listAccessibleBusinesses,
  ACTIVE_BUSINESS_COOKIE
} from "@/lib/dashboard/active-business";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/dashboard/active-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("api/dashboard/active-business route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u-1",
      email: "owner@example.com",
      isAdmin: false
    } as never);
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: BIZ, name: "A", tier: "enterprise", role: "owner", created_at: "2026-07-01" }
    ] as never);
  });

  it("sets the cookie for an accessible business", async () => {
    const res = await post({ businessId: BIZ });
    expect(res.status).toBe(200);
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      ACTIVE_BUSINESS_COOKIE,
      BIZ,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" })
    );
  });

  it("refuses a business outside the accessible set", async () => {
    const res = await post({ businessId: OTHER });
    expect(res.status).toBe(403);
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });

  it("requires auth and validates the body", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const unauth = await post({ businessId: BIZ });
    expect(unauth.status).toBe(401);

    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u-1", email: "e", isAdmin: false } as never);
    const invalid = await post({ businessId: "nope" });
    expect(invalid.status).toBe(400);
  });

  it("DELETE clears the cookie (and requires auth)", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(mockCookieStore.delete).toHaveBeenCalledWith(ACTIVE_BUSINESS_COOKIE);

    vi.mocked(getAuthUser).mockResolvedValue(null);
    const unauth = await DELETE();
    expect(unauth.status).toBe(401);
  });
});
