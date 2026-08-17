import { beforeEach, describe, expect, it, vi } from "vitest";

const listPasskeys = vi.fn();
const deletePasskey = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminPasskeyClient: vi.fn(async () => ({
    auth: { admin: { passkey: { listPasskeys, deletePasskey } } }
  }))
}));
vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));
vi.mock("@/lib/admin/view-as", () => ({ resolveViewAsTargetUser: vi.fn() }));
vi.mock("@/lib/dashboard/active-business", () => ({ resolveActiveBusinessId: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));

import { GET, DELETE } from "@/app/api/account/passkeys/route";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { logAdminAction } from "@/lib/admin/audit";

/**
 * An operator listing and revoking an impersonated tenant's passkeys.
 *
 * There is deliberately no POST to test. A passkey is minted by the tenant's
 * own authenticator and the private half never leaves their device, so
 * Supabase's admin API exposes list and delete only. "Enroll a passkey for a
 * tenant" is not a permission we lack, it is a thing that cannot exist, and
 * the route's docblock plus the card's copy say so instead of leaving an
 * operator hunting for a missing button.
 */

function deleteRequest(passkeyId: unknown): Request {
  return new Request("http://localhost/api/account/passkeys", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passkeyId })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(resolveActiveBusinessId).mockResolvedValue("biz-1");
  listPasskeys.mockResolvedValue({
    data: [
      {
        id: "pk-1",
        friendly_name: "Work laptop",
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: "2026-08-01T00:00:00Z"
      },
      { id: "pk-2", created_at: "2026-02-01T00:00:00Z" }
    ],
    error: null
  });
  deletePasskey.mockResolvedValue({ error: null });
});

describe("GET /api/account/passkeys", () => {
  it("lists the TENANT's passkeys, normalizing the optional fields", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        passkeys: [
          {
            id: "pk-1",
            friendlyName: "Work laptop",
            lastUsedAt: "2026-08-01T00:00:00Z"
          },
          { id: "pk-2", friendlyName: null, lastUsedAt: null }
        ]
      }
    });
    expect(listPasskeys).toHaveBeenCalledWith({ userId: "u-tenant" });
  });

  it("refuses when the caller is not impersonating", async () => {
    // Your own passkeys are the session-scoped card's job; keeping this route
    // impersonation-only means the two surfaces cannot be confused.
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "u-owner",
      email: "owner@example.com",
      impersonating: false
    });
    expect((await GET()).status).toBe(403);
    expect(listPasskeys).not.toHaveBeenCalled();
  });

  it("404s when the impersonated tenant has no login", async () => {
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: null,
      email: "pending-x@example.com",
      impersonating: true
    });
    expect((await GET()).status).toBe(404);
    expect(listPasskeys).not.toHaveBeenCalled();
  });

  it("500s on a lookup failure rather than reporting an empty list", async () => {
    // An empty list reads as "this tenant has no passkeys", which would send
    // an operator down the wrong path on a lockout call.
    listPasskeys.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await GET()).status).toBe(500);
  });
});

describe("DELETE /api/account/passkeys", () => {
  it("revokes the tenant's passkey and audits it", async () => {
    const res = await DELETE(deleteRequest("pk-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { removed: "pk-1" } });
    expect(deletePasskey).toHaveBeenCalledWith({ userId: "u-tenant", passkeyId: "pk-1" });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminEmail: "admin@newcoworker.com",
        action: "tenant_passkey_revoked",
        businessId: "biz-1"
      })
    );
  });

  it("refuses a non-impersonating caller before touching anything", async () => {
    vi.mocked(resolveViewAsTargetUser).mockResolvedValue({
      userId: "u-owner",
      email: "owner@example.com",
      impersonating: false
    });
    expect((await DELETE(deleteRequest("pk-1"))).status).toBe(403);
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await DELETE(deleteRequest(""))).status).toBe(400);
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  it("surfaces a delete failure", async () => {
    deletePasskey.mockResolvedValue({ error: { message: "no such passkey" } });
    const res = await DELETE(deleteRequest("pk-9"));
    expect(res.status).toBe(409);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it("still reports success when only the audit write fails", async () => {
    // The credential is already gone; a logging hiccup must not read as a
    // failed revocation an operator would retry.
    vi.mocked(resolveActiveBusinessId).mockRejectedValue(new Error("db down"));
    expect((await DELETE(deleteRequest("pk-1"))).status).toBe(200);
  });
});
