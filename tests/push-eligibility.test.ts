import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ findAuthUserIdByEmail: vi.fn() }));
vi.mock("@/lib/db/business-members", () => ({ getBusinessRoleForEmail: vi.fn() }));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import {
  callerCanEnrollTenantPush,
  listEligiblePushUserIds,
  newestOwnedBusinessId,
  ownerEmailIlikePattern,
  partitionEligiblePushRows,
  pushRegistrarBusinessId,
  tenantPushEnrollmentAllowed
} from "@/lib/push/eligibility";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "owner-1";
const MEMBER_ID = "member-1";

/**
 * Per-table query double. This helper looks at the tenant row then the
 * members list, and a single shared builder would leak one fixture into
 * the other query.
 */
function makeDb(results: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const calls: Array<[string, ...unknown[]]> = [];
  const db = {
    from: (table: string) => {
      const result = results[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      const record =
        (name: string) =>
        (...args: unknown[]) => {
          calls.push([table, name, ...args]);
          return builder;
        };
      for (const method of ["select", "eq", "is", "ilike", "in", "neq", "not", "order", "limit"]) {
        builder[method] = record(method);
      }
      const envelope = { data: result.data ?? null, error: result.error ?? null };
      builder.maybeSingle = () => Promise.resolve(envelope);
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve(envelope);
      return builder;
    }
  };
  return { db, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findAuthUserIdByEmail).mockResolvedValue(OWNER_ID);
});

describe("tenantPushEnrollmentAllowed", () => {
  it("lets a plain owner or teammate session enroll", () => {
    expect(tenantPushEnrollmentAllowed(null)).toBe(true);
  });

  it("lets the admin enroll on their own HQ tenant", () => {
    expect(tenantPushEnrollmentAllowed({ selfOwned: true })).toBe(true);
  });

  it("refuses view-as of someone else's business", () => {
    expect(tenantPushEnrollmentAllowed({ selfOwned: false })).toBe(false);
  });
});

describe("pushRegistrarBusinessId", () => {
  const HQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const KIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("uses the current tenant when this session may enroll it", () => {
    expect(
      pushRegistrarBusinessId({
        enrollCurrentTenant: true,
        currentBusinessId: HQ,
        ownBusinessId: null
      })
    ).toBe(HQ);
  });

  it("keeps the operator's own tenant while they inspect someone else", () => {
    expect(
      pushRegistrarBusinessId({
        enrollCurrentTenant: false,
        currentBusinessId: KIN,
        ownBusinessId: HQ
      })
    ).toBe(HQ);
  });

  it("enrolls nothing when foreign view-as has no owned tenant to fall back to", () => {
    expect(
      pushRegistrarBusinessId({
        enrollCurrentTenant: false,
        currentBusinessId: KIN,
        ownBusinessId: null
      })
    ).toBeNull();
  });
});

describe("ownerEmailIlikePattern", () => {
  it("lowercases and escapes LIKE metacharacters", () => {
    expect(ownerEmailIlikePattern("  A_b%x\\z@Ex.COM  ")).toBe("a\\_b\\%x\\\\z@ex.com");
  });
});

describe("newestOwnedBusinessId", () => {
  it("returns null without querying when the email is empty", async () => {
    expect(await newestOwnedBusinessId(null)).toBeNull();
    expect(await newestOwnedBusinessId("   ")).toBeNull();
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns the newest owned id and uses the escaped ilike pattern", async () => {
    const { db, calls } = makeDb({
      businesses: { data: { id: BIZ } }
    });
    expect(await newestOwnedBusinessId("A_b@x.com", db as never)).toBe(BIZ);
    expect(calls).toContainEqual(["businesses", "ilike", "owner_email", "a\\_b@x.com"]);
    expect(calls).toContainEqual(["businesses", "order", "created_at", { ascending: false }]);
    expect(calls).toContainEqual(["businesses", "limit", 1]);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns null when no owned row exists", async () => {
    const { db } = makeDb({ businesses: { data: null } });
    expect(await newestOwnedBusinessId("owner@example.com", db as never)).toBeNull();
  });

  it("returns null when the owned row has no id", async () => {
    const { db } = makeDb({ businesses: { data: { id: "" } } });
    expect(await newestOwnedBusinessId("owner@example.com", db as never)).toBeNull();
  });

  it("returns null on a businesses read error", async () => {
    const { db } = makeDb({
      businesses: { error: { message: "pg down" } }
    });
    expect(await newestOwnedBusinessId("owner@example.com", db as never)).toBeNull();
  });

  it("returns null when the client itself cannot be built", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no service key"));
    expect(await newestOwnedBusinessId("owner@example.com")).toBeNull();
  });

  it("mints a client when none is supplied", async () => {
    const { db } = makeDb({ businesses: { data: { id: BIZ } } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await newestOwnedBusinessId("owner@example.com")).toBe(BIZ);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("callerCanEnrollTenantPush", () => {
  it("refuses a session with no email without looking anyone up", async () => {
    expect(await callerCanEnrollTenantPush({ email: null, businessId: BIZ })).toBe(false);
    expect(getBusinessRoleForEmail).not.toHaveBeenCalled();
  });

  it.each(["owner", "manager", "staff"] as const)("lets a %s enroll", async (role) => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(role);
    expect(await callerCanEnrollTenantPush({ email: "a@b.com", businessId: BIZ })).toBe(true);
    expect(getBusinessRoleForEmail).toHaveBeenCalledWith(BIZ, "a@b.com");
  });

  it("refuses an address with no roster role, including the HQ admin bypass case", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null);
    expect(
      await callerCanEnrollTenantPush({ email: "admin@hq.test", businessId: BIZ })
    ).toBe(false);
  });
});

describe("listEligiblePushUserIds", () => {
  it("includes the owner and active/invited members with a dashboard role", async () => {
    const { db, calls } = makeDb({
      businesses: { data: { owner_email: "owner@example.com" } },
      business_members: {
        data: [
          { user_id: MEMBER_ID, role: "staff", status: "active" },
          { user_id: "invited-1", role: "manager", status: "invited" },
          { user_id: null, role: "staff", status: "active" },
          { user_id: "bad-role", role: "not-a-role", status: "active" }
        ]
      }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const ids = await listEligiblePushUserIds(BIZ);
    expect(ids).toEqual(new Set([OWNER_ID, MEMBER_ID, "invited-1"]));
    expect(findAuthUserIdByEmail).toHaveBeenCalledWith("owner@example.com");
    expect(calls).toContainEqual(["business_members", "in", "status", ["active", "invited"]]);
  });

  it("fails open when the owner email is set but the auth id does not resolve", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_email: "owner@example.com" } },
      business_members: { data: [] }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    vi.mocked(findAuthUserIdByEmail).mockResolvedValue(null);
    expect(await listEligiblePushUserIds(BIZ)).toBeNull();
  });

  it("returns an empty set when the business has no owner login and no members", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_email: "   " } },
      business_members: { data: null }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listEligiblePushUserIds(BIZ)).toEqual(new Set());
  });

  it("returns an empty set when the business row is gone", async () => {
    const { db } = makeDb({
      businesses: { data: null },
      business_members: { data: [] }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listEligiblePushUserIds(BIZ)).toEqual(new Set());
  });

  it("fails open on a businesses read error", async () => {
    const { db } = makeDb({
      businesses: { error: { message: "pg down" } }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listEligiblePushUserIds(BIZ)).toBeNull();
  });

  it("fails open on a members read error", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_email: "owner@example.com" } },
      business_members: { error: { message: "pg down" } }
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listEligiblePushUserIds(BIZ)).toBeNull();
  });

  it("fails open when the client itself cannot be built", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no service key"));
    expect(await listEligiblePushUserIds(BIZ)).toBeNull();
  });

  it("uses a supplied client instead of minting one", async () => {
    const { db } = makeDb({
      businesses: { data: { owner_email: "" } },
      business_members: { data: [] }
    });
    expect(await listEligiblePushUserIds(BIZ, db as never)).toEqual(new Set());
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});

describe("partitionEligiblePushRows", () => {
  const owner = { user_id: OWNER_ID, endpoint: "a" };
  const admin = { user_id: "admin-1", endpoint: "b" };

  it("keeps every row when the lookup failed, so a blip cannot drop the owner", () => {
    expect(partitionEligiblePushRows([owner, admin], null)).toEqual({
      keep: [owner, admin],
      leaked: []
    });
  });

  it("splits roster devices from everyone else when the set is authoritative", () => {
    expect(partitionEligiblePushRows([owner, admin], new Set([OWNER_ID]))).toEqual({
      keep: [owner],
      leaked: [admin]
    });
  });

  it("treats an empty set as nobody eligible", () => {
    expect(partitionEligiblePushRows([owner], new Set())).toEqual({
      keep: [],
      leaked: [owner]
    });
  });
});
