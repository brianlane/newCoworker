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

// The auth-directory lookup behind resolveViewAsTargetUser. Mocked rather
// than stubbed through Supabase because it has its own RPC-plus-fallback
// contract (tested in the auth suite) and this file only cares WHICH email it
// is asked about.
vi.mock("@/lib/auth", () => ({
  findAuthUserIdByEmail: vi.fn()
}));

import {
  getViewAsBusinessId,
  resolveViewAsContext,
  resolveDashboardOwnerEmail,
  resolveViewAsTargetUser
} from "@/lib/admin/view-as";
import { findAuthUserIdByEmail } from "@/lib/auth";
import type { AuthUser } from "@/lib/auth";

const BIZ_ID = "0395f00c-8023-4cf5-bde9-db07fc5f0027";

const admin: AuthUser = { userId: "u-admin", email: "admin@x.com", isAdmin: true };
const owner: AuthUser = { userId: "u-own", email: "owner@x.com", isAdmin: false };

beforeEach(() => {
  cookieGet.mockReset();
  maybeSingle.mockReset();
  cookiesImpl.mockReset();
  cookiesImpl.mockImplementation(async () => ({ get: cookieGet }));
  vi.mocked(findAuthUserIdByEmail).mockReset();
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
    // and the banner off its presence) but is flagged selfOwned so the banner
    // says so and the user-scoped routes skip their owner lookup. Email match
    // is case-insensitive.
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

describe("resolveViewAsTargetUser", () => {
  it("is the caller themselves when no view-as is active", async () => {
    // The common path for every real owner and teammate: identity
    // pass-through, and no auth-directory lookup at all.
    cookieGet.mockReturnValue(undefined);
    expect(await resolveViewAsTargetUser(owner)).toEqual({
      userId: "u-own",
      email: "owner@x.com",
      impersonating: false
    });
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
  });

  it("resolves the impersonated owner's auth user, not the admin's", async () => {
    // The whole point: a USER-scoped write (login email, UI locale, the
    // auth-user teardown in account delete) must land on the tenant's login.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "Amy's Plumbing", tier: "starter", owner_email: "amy@x.com" }
    });
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue("u-amy");
    expect(await resolveViewAsTargetUser(admin)).toEqual({
      userId: "u-amy",
      email: "amy@x.com",
      impersonating: true
    });
    expect(findAuthUserIdByEmail).toHaveBeenCalledWith("amy@x.com");
  });

  it("reports userId null when the tenant's owner_email has no login", async () => {
    // A pending/placeholder owner_email, or a login already deleted. Callers
    // MUST refuse on this rather than fall back to the signed-in admin:
    // that fallback is exactly the wrong-row bug this resolver prevents.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "Pending", tier: "starter", owner_email: "pending-x@x.com" }
    });
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);
    expect(await resolveViewAsTargetUser(admin)).toEqual({
      userId: null,
      email: "pending-x@x.com",
      impersonating: true
    });
  });

  it("does not impersonate on self-owned view-as (the HQ tenant)", async () => {
    // The impersonated owner already IS the signed-in user, so there is
    // nothing to retarget and no reason to pay for the directory lookup.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, name: "HQ", tier: "standard", owner_email: "Admin@X.com" }
    });
    expect(await resolveViewAsTargetUser(admin)).toEqual({
      userId: "u-admin",
      email: "admin@x.com",
      impersonating: false
    });
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
  });

  it("does not impersonate when the cookie points at a deleted business", async () => {
    // resolveViewAsContext already fell back to the admin's own identity, so
    // an orphan cookie must not make a user-scoped route refuse.
    cookieGet.mockReturnValue({ value: BIZ_ID });
    maybeSingle.mockResolvedValue({ data: null });
    expect(await resolveViewAsTargetUser(admin)).toEqual({
      userId: "u-admin",
      email: "admin@x.com",
      impersonating: false
    });
  });

  it("is inert for a non-admin with a forged cookie", async () => {
    cookieGet.mockReturnValue({ value: BIZ_ID });
    expect(await resolveViewAsTargetUser(owner)).toEqual({
      userId: "u-own",
      email: "owner@x.com",
      impersonating: false
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
