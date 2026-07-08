import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCookies } = vi.hoisted(() => ({
  mockCookies: vi.fn()
}));

vi.mock("next/headers", () => ({
  cookies: mockCookies
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/admin/view-as", () => ({
  getViewAsBusinessId: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getViewAsBusinessId } from "@/lib/admin/view-as";
import {
  listAccessibleBusinesses,
  getActiveBusinessCookie,
  resolveActiveBusinessContext,
  resolveActiveBusinessId,
  resolveActiveBusinessIdForAction,
  ACTIVE_BUSINESS_COOKIE
} from "@/lib/dashboard/active-business";
import type { AuthUser } from "@/lib/auth";

const USER: AuthUser = {
  userId: "u-1",
  email: "owner@example.com",
  isAdmin: false
};

const OWNED_A = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Newest Owned", tier: "enterprise", created_at: "2026-07-01T00:00:00Z" };
const OWNED_B = { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Older Owned", tier: "starter", created_at: "2026-06-01T00:00:00Z" };
const MEMBER_BIZ = { id: "bbbbbbbb-0000-4000-8000-000000000003", name: "Member Biz", tier: "enterprise", created_at: "2026-05-01T00:00:00Z" };

/**
 * A db whose from() dispatches per table: businesses → owned result,
 * business_members → memberships result.
 */
function twoTableDb(
  owned: { data?: unknown; error?: { message: string } | null },
  memberships: { data?: unknown; error?: { message: string } | null } = { data: [] }
) {
  return {
    from: vi.fn((table: string) => {
      if (table === "businesses") {
        const order = vi.fn(async () => ({ data: owned.data ?? null, error: owned.error ?? null }));
        const ilike = vi.fn(() => ({ order }));
        const select = vi.fn(() => ({ ilike }));
        return { select };
      }
      const neq = vi.fn(async () => ({
        data: memberships.data ?? null,
        error: memberships.error ?? null
      }));
      const eq = vi.fn(() => ({ neq }));
      const select = vi.fn(() => ({ eq }));
      return { select };
    })
  };
}

function withCookie(value: string | null) {
  mockCookies.mockResolvedValue({
    get: vi.fn(() => (value === null ? undefined : { value }))
  } as never);
}

describe("listAccessibleBusinesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withCookie(null);
    vi.mocked(getViewAsBusinessId).mockResolvedValue(null);
  });

  it("returns [] for a user without an email", async () => {
    expect(await listAccessibleBusinesses({ ...USER, email: null })).toEqual([]);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns owned businesses (owner role) then membership businesses, deduped", async () => {
    const db = twoTableDb(
      { data: [OWNED_A, OWNED_B] },
      {
        data: [
          { business_id: MEMBER_BIZ.id, role: "manager", status: "active", businesses: MEMBER_BIZ },
          // Also a member of an OWNED business — owner wins, no duplicate.
          { business_id: OWNED_A.id, role: "staff", status: "active", businesses: OWNED_A },
          // Broken join row is skipped.
          { business_id: "dead", role: "staff", status: "active", businesses: null }
        ]
      }
    );
    const result = await listAccessibleBusinesses(USER, db as never);
    expect(result.map((b) => [b.businessId, b.role])).toEqual([
      [OWNED_A.id, "owner"],
      [OWNED_B.id, "owner"],
      [MEMBER_BIZ.id, "manager"]
    ]);
  });

  it("sorts multiple membership businesses newest-first", async () => {
    const newer = { ...MEMBER_BIZ, id: "bbbbbbbb-0000-4000-8000-000000000004", created_at: "2026-06-15T00:00:00Z" };
    const newest = { ...MEMBER_BIZ, id: "bbbbbbbb-0000-4000-8000-000000000005", created_at: "2026-06-20T00:00:00Z" };
    const db = twoTableDb(
      { data: [] },
      {
        data: [
          // Mixed input order so the comparator takes both branches.
          { business_id: MEMBER_BIZ.id, role: "staff", status: "invited", businesses: MEMBER_BIZ },
          { business_id: newest.id, role: "staff", status: "active", businesses: newest },
          { business_id: newer.id, role: "manager", status: "active", businesses: newer }
        ]
      }
    );
    const result = await listAccessibleBusinesses(USER, db as never);
    expect(result.map((b) => b.businessId)).toEqual([newest.id, newer.id, MEMBER_BIZ.id]);
  });

  it("throws on query errors (both tables) and null data is tolerated", async () => {
    await expect(
      listAccessibleBusinesses(USER, twoTableDb({ error: { message: "boom" } }) as never)
    ).rejects.toThrow("listAccessibleBusinesses: boom");
    await expect(
      listAccessibleBusinesses(
        USER,
        twoTableDb({ data: [] }, { error: { message: "kaboom" } }) as never
      )
    ).rejects.toThrow("listAccessibleBusinesses: kaboom");

    const db = twoTableDb({ data: null }, { data: null });
    expect(await listAccessibleBusinesses(USER, db as never)).toEqual([]);
  });

  it("falls back to the service client when none is provided", async () => {
    const db = twoTableDb({ data: [OWNED_A] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const result = await listAccessibleBusinesses(USER);
    expect(result).toHaveLength(1);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });

  it("matches owned businesses case-insensitively with LIKE metacharacters escaped", async () => {
    const ilikeCalls: unknown[][] = [];
    const db = {
      from: vi.fn((table: string) =>
        table === "businesses"
          ? {
              select: () => ({
                ilike: (...args: unknown[]) => {
                  ilikeCalls.push(args);
                  return { order: async () => ({ data: [], error: null }) };
                }
              })
            }
          : {
              select: () => ({
                eq: () => ({ neq: async () => ({ data: [], error: null }) })
              })
            }
      )
    };
    await listAccessibleBusinesses({ ...USER, email: " Owner_Name%@Example.COM " }, db as never);
    expect(ilikeCalls[0]).toEqual(["owner_email", "owner\\_name\\%@example.com"]);
  });
});

describe("getActiveBusinessCookie", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a valid uuid cookie and rejects garbage/missing", async () => {
    withCookie(OWNED_A.id);
    expect(await getActiveBusinessCookie()).toBe(OWNED_A.id);

    withCookie("not-a-uuid");
    expect(await getActiveBusinessCookie()).toBeNull();

    withCookie(null);
    expect(await getActiveBusinessCookie()).toBeNull();
  });

  it("returns null when cookies() throws (outside request scope)", async () => {
    mockCookies.mockRejectedValue(new Error("no request scope"));
    expect(await getActiveBusinessCookie()).toBeNull();
  });
});

describe("resolveActiveBusinessContext / Id / IdForAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withCookie(null);
    vi.mocked(getViewAsBusinessId).mockResolvedValue(null);
  });

  it("admin view-as pins the impersonated business as owner, no accessible list", async () => {
    vi.mocked(getViewAsBusinessId).mockResolvedValue(MEMBER_BIZ.id);
    const ctx = await resolveActiveBusinessContext({ ...USER, isAdmin: true });
    expect(ctx).toEqual({ businessId: MEMBER_BIZ.id, role: "owner", accessible: [] });
  });

  it("returns nulls when nothing is accessible", async () => {
    const db = twoTableDb({ data: [] });
    const ctx = await resolveActiveBusinessContext(USER, db as never);
    expect(ctx.businessId).toBeNull();
    expect(ctx.role).toBeNull();
  });

  it("defaults to the newest owned business without a cookie", async () => {
    const db = twoTableDb({ data: [OWNED_A, OWNED_B] });
    const ctx = await resolveActiveBusinessContext(USER, db as never);
    expect(ctx.businessId).toBe(OWNED_A.id);
    expect(ctx.role).toBe("owner");
  });

  it("honors a cookie that points inside the accessible set", async () => {
    withCookie(OWNED_B.id);
    const db = twoTableDb({ data: [OWNED_A, OWNED_B] });
    const ctx = await resolveActiveBusinessContext(USER, db as never);
    expect(ctx.businessId).toBe(OWNED_B.id);
  });

  it("ignores a cookie pointing outside the accessible set (forged/stale)", async () => {
    withCookie(MEMBER_BIZ.id);
    const db = twoTableDb({ data: [OWNED_A] });
    const ctx = await resolveActiveBusinessContext(USER, db as never);
    expect(ctx.businessId).toBe(OWNED_A.id);
  });

  it("resolveActiveBusinessId returns just the id", async () => {
    const db = twoTableDb({ data: [OWNED_A] });
    expect(await resolveActiveBusinessId(USER, db as never)).toBe(OWNED_A.id);
  });

  it("resolveActiveBusinessIdForAction enforces the matrix", async () => {
    const memberDb = () =>
      twoTableDb(
        { data: [] },
        {
          data: [
            { business_id: MEMBER_BIZ.id, role: "staff", status: "active", businesses: MEMBER_BIZ }
          ]
        }
      );
    // Staff can view the dashboard…
    expect(
      await resolveActiveBusinessIdForAction(USER, "view_dashboard", memberDb() as never)
    ).toBe(MEMBER_BIZ.id);
    // …but cannot bill it.
    expect(
      await resolveActiveBusinessIdForAction(USER, "manage_billing", memberDb() as never)
    ).toBeNull();
    // No accessible business → null.
    expect(
      await resolveActiveBusinessIdForAction(USER, "view_dashboard", twoTableDb({ data: [] }) as never)
    ).toBeNull();
  });
});

describe("cookie name", () => {
  it("is stable (the API route and layout share it)", () => {
    expect(ACTIVE_BUSINESS_COOKIE).toBe("active_business");
  });
});
