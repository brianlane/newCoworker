import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieGet = vi.fn();
const cookiesImpl = vi.fn(async () => ({ get: cookieGet }));
vi.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => cookiesImpl(...(args as []))
}));

// One shared maybeSingle drives BOTH queries resolveViewAsContext makes: the
// by-id cookie lookup (from().select().eq().maybeSingle()) first, then the
// newest-row-for-owner lookup (…eq().order().limit().maybeSingle()).
const maybeSingle = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn().mockImplementation(async () => ({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle,
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({ maybeSingle })
          })
        })
      })
    })
  }))
}));

import {
  getViewAsBusinessId,
  resolveViewAsContext,
  resolveDashboardOwnerEmail,
  isViewAsActive
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
      viewAs: { businessId: BIZ_ID, name: "Amy's Plumbing", tier: "starter", selfOwned: false }
    });
  });

  it("banner follows the NEWEST business when the owner has several (pages resolve newest)", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle
      .mockResolvedValueOnce({
        data: { id: BIZ_ID, name: "Old Biz", tier: "starter", owner_email: "multi@x.com" }
      })
      .mockResolvedValueOnce({
        data: { id: "9d1f00c0-8023-4cf5-bde9-db07fc5f0027", name: "New Biz", tier: "standard" }
      });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "multi@x.com",
      viewAs: {
        businessId: "9d1f00c0-8023-4cf5-bde9-db07fc5f0027",
        name: "New Biz",
        tier: "standard",
        selfOwned: false
      }
    });
  });

  it("keeps the cookie's business when the newest-row lookup returns nothing", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle
      .mockResolvedValueOnce({
        data: { id: BIZ_ID, name: "Solo Biz", tier: "starter", owner_email: "solo@x.com" }
      })
      .mockResolvedValueOnce({ data: null });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "solo@x.com",
      viewAs: { businessId: BIZ_ID, name: "Solo Biz", tier: "starter", selfOwned: false }
    });
  });

  it("defaults a null name/tier on the impersonated business", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: null, tier: null, owner_email: "amy@x.com" }
    });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "amy@x.com",
      viewAs: { businessId: BIZ_ID, name: "", tier: "starter", selfOwned: false }
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

  it("marks self-impersonation (admin-owned business) selfOwned, keeping the context", async () => {
    // The internal HQ tenant is owned by the admin email itself. The context
    // stays non-null (the dashboard layout keys the admin→/admin redirect
    // and the banner off its presence) but is flagged selfOwned so the
    // read-only write guard does not fire. Email match is case-insensitive.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "HQ", tier: "standard", owner_email: "Admin@X.com" }
    });
    expect(await resolveViewAsContext(admin)).toEqual({
      ownerEmail: "Admin@X.com",
      viewAs: { businessId: BIZ_ID, name: "HQ", tier: "standard", selfOwned: true }
    });
  });
});

describe("isViewAsActive", () => {
  it("is true only for an admin whose cookie resolves to a live business", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "B", tier: "starter", owner_email: "b@x.com" }
    });
    expect(await isViewAsActive(admin)).toBe(true);
    expect(await isViewAsActive(owner)).toBe(false);
    expect(await isViewAsActive(null)).toBe(false);
    cookieGet.mockReturnValue(undefined);
    expect(await isViewAsActive(admin)).toBe(false);
  });

  it("goes inactive when the cookie points at a deleted business (no 403 lock-out)", async () => {
    // The dashboard already fell back to the admin's own identity and hides
    // the exit banner in this state — blocking writes would strand the admin.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({ data: null });
    expect(await isViewAsActive(admin)).toBe(false);
  });

  it("stays inactive when the admin views their own business (HQ tenant)", async () => {
    // Writes stay allowed: email-resolved mutations target the exact
    // business being viewed, so the wrong-tenant hazard cannot occur.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "HQ", tier: "standard", owner_email: "admin@x.com" }
    });
    expect(await isViewAsActive(admin)).toBe(false);
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
