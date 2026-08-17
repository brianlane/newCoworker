import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/admin/view-as", () => ({ resolveViewAsTargetUser: vi.fn() }));
vi.mock("@/lib/account/email-change", () => ({ moveBusinessesToNewOwnerEmail: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceClient: vi.fn()
}));

import { POST } from "@/app/api/account/email/route";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { moveBusinessesToNewOwnerEmail } from "@/lib/account/email-change";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Changing an account's login email.
 *
 * Two paths that must not be confused, because they differ in WHOSE login
 * moves and WHEN:
 *
 *  - Owner changing their own: Supabase emails confirmation links, the auth
 *    email stays put, and a pending_email_changes row lets the reconciler move
 *    businesses.owner_email once a link is clicked.
 *  - Admin in view-as changing a tenant's: there is no link the operator can
 *    click, so the auth email moves immediately and the businesses follow in
 *    the same request. Crucially it must move the TENANT's login, never the
 *    operator's.
 */

const updateUserById = vi.fn();
const upsert = vi.fn();
const maybeSingle = vi.fn();
const ssrUpdateUser = vi.fn();

function request(email: string): Request {
  return new Request("http://localhost/api/account/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({
    userId: "u-owner",
    email: "owner@example.com",
    isAdmin: false
  } as never);
  // Default: nobody is impersonating, so the target is the caller.
  vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
    userId: "u-owner",
    email: "owner@example.com",
    impersonating: false
  });
  updateUserById.mockResolvedValue({ error: null });
  upsert.mockResolvedValue({ error: null });
  maybeSingle.mockResolvedValue({ data: { id: "biz-1" } });
  ssrUpdateUser.mockResolvedValue({ error: null });
  vi.mocked(moveBusinessesToNewOwnerEmail).mockResolvedValue(1);
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    auth: { admin: { updateUserById } },
    from: vi.fn().mockReturnValue({
      upsert,
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle }) })
      })
    })
  } as never);
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { updateUser: ssrUpdateUser }
  } as never);
});

describe("POST /api/account/email", () => {
  it("owner path records a pending change and asks Supabase to send the links", async () => {
    const res = await POST(request("new@example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { pending: "new@example.com" } });
    // The pending row is keyed to the CALLER's user id and old email.
    expect(upsert).toHaveBeenCalledWith({
      user_id: "u-owner",
      old_email: "owner@example.com",
      new_email: "new@example.com"
    });
    expect(ssrUpdateUser).toHaveBeenCalled();
    // The immediate admin path must not run for an owner.
    expect(updateUserById).not.toHaveBeenCalled();
    expect(moveBusinessesToNewOwnerEmail).not.toHaveBeenCalled();
  });

  it("admin in view-as moves the TENANT's login immediately, not the operator's", async () => {
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

    const res = await POST(request("new@example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { changed: "new@example.com", businessesMoved: 1 }
    });
    // The TENANT's auth user, confirmed on the operator's word (there is no
    // link for the tenant to click), and the businesses follow the login.
    expect(updateUserById).toHaveBeenCalledWith("u-tenant", {
      email: "new@example.com",
      email_confirm: true
    });
    expect(moveBusinessesToNewOwnerEmail).toHaveBeenCalledWith(
      "tenant@example.com",
      "new@example.com",
      expect.anything()
    );
    // No confirm-by-link machinery on this path: nothing to reconcile later.
    expect(upsert).not.toHaveBeenCalled();
    expect(ssrUpdateUser).not.toHaveBeenCalled();
  });

  it("does not move the businesses when the auth email change is rejected", async () => {
    // Ordering guard: a business pointed at an email no login holds would
    // strand the tenant.
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "u-tenant",
      email: "tenant@example.com",
      impersonating: true
    });
    updateUserById.mockResolvedValue({ error: { message: "email already in use" } });

    const res = await POST(request("taken@example.com"));
    expect(res.status).toBe(409);
    expect(moveBusinessesToNewOwnerEmail).not.toHaveBeenCalled();
  });

  it("404s when the impersonated tenant's owner_email has no login", async () => {
    // Never fall back to renaming the operator's own account.
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: null,
      email: "pending-x@example.com",
      impersonating: true
    });
    const res = await POST(request("new@example.com"));
    expect(res.status).toBe(404);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(moveBusinessesToNewOwnerEmail).not.toHaveBeenCalled();
  });

  it("rejects an unchanged email, naming whose account it is", async () => {
    const own = await POST(request("owner@example.com"));
    expect(own.status).toBe(400);
    expect((await own.json()).error.message).toContain("your account email");

    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "u-tenant",
      email: "tenant@example.com",
      impersonating: true
    });
    const tenant = await POST(request("tenant@example.com"));
    expect(tenant.status).toBe(400);
    expect((await tenant.json()).error.message).toContain("this account's email");
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    expect((await POST(request("new@example.com"))).status).toBe(401);
  });

  it("404s the owner path when no business is keyed to their email", async () => {
    maybeSingle.mockResolvedValue({ data: null });
    expect((await POST(request("new@example.com"))).status).toBe(404);
  });
});
