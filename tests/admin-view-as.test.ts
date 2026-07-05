import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieGet = vi.fn();
const cookiesImpl = vi.fn(async () => ({ get: cookieGet }));
vi.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => cookiesImpl(...(args as []))
}));

const maybeSingle = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockImplementation(async () => ({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle })
      })
    })
  }))
}));

import {
  getViewAsBusinessId,
  resolveViewAsContext,
  resolveDashboardOwnerEmail
} from "@/lib/admin/view-as";
import type { AuthUser } from "@/lib/auth";

const BIZ_ID = "0395f00c-8023-4cf5-bde9-db07fc5f0027";

const admin: AuthUser = { userId: "u-admin", email: "admin@x.com", isAdmin: true };
const owner: AuthUser = { userId: "u-own", email: "owner@x.com", isAdmin: false };

beforeEach(() => {
  cookieGet.mockReset();
  maybeSingle.mockReset();
  cookiesImpl.mockReset();
  cookiesImpl.mockImplementation(async () => ({ get: cookieGet }));
});

describe("getViewAsBusinessId", () => {
  it("returns the cookie's uuid for the admin", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    expect(await getViewAsBusinessId(admin)).toBe(BIZ_ID);
  });

  it("is inert for non-admins even when the cookie is set (forged cookie)", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    expect(await getViewAsBusinessId(owner)).toBeNull();
    expect(await getViewAsBusinessId(null)).toBeNull();
  });

  it("rejects non-uuid cookie values", async () => {
    cookieGet.mockReturnValue({ value: "'; drop table businesses; --" });
    expect(await getViewAsBusinessId(admin)).toBeNull();
    cookieGet.mockReturnValue(undefined);
    expect(await getViewAsBusinessId(admin)).toBeNull();
  });

  it("returns null when cookies() throws (outside a request scope)", async () => {
    cookiesImpl.mockImplementation(async () => {
      throw new Error("cookies was called outside a request scope");
    });
    expect(await getViewAsBusinessId(admin)).toBeNull();
  });
});

describe("resolveViewAsContext", () => {
  it("passes the user's own email through when no view-as is active", async () => {
    cookieGet.mockReturnValue(undefined);
    expect(await resolveViewAsContext(owner)).toEqual({
      ownerEmail: "owner@x.com",
      viewAs: null
    });
  });

  it("maps an active view-as to the impersonated business's owner email", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "Amy's Plumbing", tier: "starter", owner_email: "amy@x.com" }
    });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "amy@x.com",
      viewAs: { businessId: BIZ_ID, name: "Amy's Plumbing", tier: "starter" }
    });
  });

  it("defaults a null name/tier on the impersonated business", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: null, tier: null, owner_email: "amy@x.com" }
    });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "amy@x.com",
      viewAs: { businessId: BIZ_ID, name: "", tier: "starter" }
    });
  });

  it("falls back to the admin's own email when the business no longer exists", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({ data: null });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "admin@x.com",
      viewAs: null
    });
  });
});

describe("resolveDashboardOwnerEmail", () => {
  it("is the ownerEmail shorthand", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "B", tier: "standard", owner_email: "b@x.com" }
    });
    expect(await resolveDashboardOwnerEmail(admin)).toBe("b@x.com");
    cookieGet.mockReturnValue(undefined);
    expect(await resolveDashboardOwnerEmail(owner)).toBe("owner@x.com");
  });
});
