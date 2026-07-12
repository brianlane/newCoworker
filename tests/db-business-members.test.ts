import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  listBusinessMembers,
  listAllBusinessMembers,
  getBusinessMember,
  inviteBusinessMember,
  updateBusinessMemberRole,
  revokeBusinessMember,
  bindBusinessMemberUser,
  getBusinessRoleForEmail,
  BusinessMemberConflictError,
  MAX_MEMBERS_PER_BUSINESS
} from "@/lib/db/business-members";

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

const BIZ = "11111111-1111-4111-8111-111111111111";

const MEMBER = {
  id: "22222222-2222-4222-8222-222222222222",
  business_id: BIZ,
  email: "staffer@example.com",
  user_id: null,
  role: "staff" as const,
  status: "invited" as const,
  invited_by: "owner@example.com",
  employee_id: null,
  created_at: "2026-07-08T00:00:00Z",
  accepted_at: null,
  revoked_at: null
};

describe("db/business-members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listBusinessMembers returns rows ([] for null data) and throws on error", async () => {
    const db = mockDb({ order: vi.fn().mockResolvedValue({ data: [MEMBER], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listBusinessMembers(BIZ)).toEqual([MEMBER]);

    const empty = mockDb({ order: vi.fn().mockResolvedValue({ data: null, error: null }) });
    expect(await listBusinessMembers(BIZ, empty as never)).toEqual([]);

    const bad = mockDb({
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    await expect(listBusinessMembers(BIZ, bad as never)).rejects.toThrow(
      "listBusinessMembers: boom"
    );
  });

  it("listAllBusinessMembers returns rows ([] for null data) and throws on error", async () => {
    const db = mockDb({ order: vi.fn().mockResolvedValue({ data: [MEMBER], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listAllBusinessMembers()).toEqual([MEMBER]);
    // Cross-business list: no business_id filter is applied.
    expect(db.eq).not.toHaveBeenCalled();

    const empty = mockDb({ order: vi.fn().mockResolvedValue({ data: null, error: null }) });
    expect(await listAllBusinessMembers(empty as never)).toEqual([]);

    const bad = mockDb({
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    await expect(listAllBusinessMembers(bad as never)).rejects.toThrow(
      "listAllBusinessMembers: boom"
    );
  });

  it("getBusinessMember returns the row, null when absent, and throws on error", async () => {
    const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: MEMBER, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getBusinessMember(BIZ, MEMBER.id)).toEqual(MEMBER);

    const missing = mockDb();
    expect(await getBusinessMember(BIZ, MEMBER.id, missing as never)).toBeNull();

    const bad = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    await expect(getBusinessMember(BIZ, MEMBER.id, bad as never)).rejects.toThrow(
      "getBusinessMember: boom"
    );
  });

  describe("inviteBusinessMember", () => {
    it("inserts a fresh invite (email lowercased, employee link optional)", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
        single: vi.fn().mockResolvedValue({ data: MEMBER, error: null })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const row = await inviteBusinessMember({
        businessId: BIZ,
        email: "  Staffer@Example.com ",
        role: "staff",
        invitedBy: "owner@example.com"
      });
      expect(row).toEqual(MEMBER);
      expect(db.insert).toHaveBeenCalledWith({
        business_id: BIZ,
        email: "staffer@example.com",
        role: "staff",
        invited_by: "owner@example.com",
        employee_id: null
      });
    });

    it("passes an explicit employee link through", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
        single: vi.fn().mockResolvedValue({ data: MEMBER, error: null })
      });
      await inviteBusinessMember(
        {
          businessId: BIZ,
          email: "a@b.co",
          role: "manager",
          invitedBy: "owner@example.com",
          employeeId: "33333333-3333-4333-8333-333333333333"
        },
        db as never
      );
      expect(db.insert).toHaveBeenCalledWith(
        expect.objectContaining({ employee_id: "33333333-3333-4333-8333-333333333333" })
      );
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    });

    it("conflicts when the email already has a live membership", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [MEMBER], error: null })
      });
      await expect(
        inviteBusinessMember(
          { businessId: BIZ, email: "STAFFER@example.com", role: "staff", invitedBy: "o@o.co" },
          db as never
        )
      ).rejects.toThrow(BusinessMemberConflictError);
    });

    it("conflicts at the member cap", async () => {
      const crowd = Array.from({ length: MAX_MEMBERS_PER_BUSINESS }, (_, i) => ({
        ...MEMBER,
        id: `id-${i}`,
        email: `m${i}@example.com`,
        status: "active"
      }));
      const db = mockDb({ order: vi.fn().mockResolvedValue({ data: crowd, error: null }) });
      await expect(
        inviteBusinessMember(
          { businessId: BIZ, email: "new@example.com", role: "staff", invitedBy: "o@o.co" },
          db as never
        )
      ).rejects.toThrow(/cap/);
    });

    it("re-invites a revoked row (flips back to invited with the new role)", async () => {
      const revoked = { ...MEMBER, status: "revoked" as const };
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [revoked], error: null }),
        single: vi.fn().mockResolvedValue({ data: { ...revoked, status: "invited" }, error: null })
      });
      const row = await inviteBusinessMember(
        { businessId: BIZ, email: MEMBER.email, role: "manager", invitedBy: "o@o.co" },
        db as never
      );
      expect(row.status).toBe("invited");
      expect(db.update).toHaveBeenCalledWith(
        expect.objectContaining({ role: "manager", status: "invited", user_id: null })
      );
      // Guarded on status so a racing acceptance wins.
      expect(db.eq).toHaveBeenCalledWith("status", "revoked");
    });

    it("throws on re-invite write error", async () => {
      const revoked = { ...MEMBER, status: "revoked" as const };
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [revoked], error: null }),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
      });
      await expect(
        inviteBusinessMember(
          { businessId: BIZ, email: MEMBER.email, role: "staff", invitedBy: "o@o.co" },
          db as never
        )
      ).rejects.toThrow("inviteBusinessMember (re-invite): boom");
    });

    it("maps the unique-index violation to a conflict (concurrent invite race)", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'violates unique constraint "business_members_business_email_idx"' }
        })
      });
      await expect(
        inviteBusinessMember(
          { businessId: BIZ, email: "new@example.com", role: "staff", invitedBy: "o@o.co" },
          db as never
        )
      ).rejects.toThrow(BusinessMemberConflictError);
    });

    it("throws on other insert errors", async () => {
      const db = mockDb({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
      });
      await expect(
        inviteBusinessMember(
          { businessId: BIZ, email: "new@example.com", role: "staff", invitedBy: "o@o.co" },
          db as never
        )
      ).rejects.toThrow("inviteBusinessMember: boom");
    });
  });

  it("updateBusinessMemberRole flips live rows only and throws on error", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: MEMBER.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await updateBusinessMemberRole(BIZ, MEMBER.id, "manager")).toBe(true);
    expect(db.neq).toHaveBeenCalledWith("status", "revoked");

    const none = mockDb({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    expect(await updateBusinessMemberRole(BIZ, MEMBER.id, "staff", none as never)).toBe(false);

    const bad = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    await expect(updateBusinessMemberRole(BIZ, MEMBER.id, "staff", bad as never)).rejects.toThrow(
      "updateBusinessMemberRole: boom"
    );
  });

  it("revokeBusinessMember stamps revoked_at, no-ops on already-revoked, throws on error", async () => {
    const db = mockDb({ select: vi.fn().mockResolvedValue({ data: [{ id: MEMBER.id }], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await revokeBusinessMember(BIZ, MEMBER.id)).toBe(true);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revoked", revoked_at: expect.any(String) })
    );

    const none = mockDb({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    expect(await revokeBusinessMember(BIZ, MEMBER.id, none as never)).toBe(false);

    const bad = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    await expect(revokeBusinessMember(BIZ, MEMBER.id, bad as never)).rejects.toThrow(
      "revokeBusinessMember: boom"
    );
  });

  it("bindBusinessMemberUser activates invited rows for the email", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: [{ id: "m1" }, { id: "m2" }], error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await bindBusinessMemberUser("user-1", " Staffer@Example.com ")).toBe(2);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", status: "active" })
    );
    expect(db.eq).toHaveBeenCalledWith("status", "invited");
    expect(db.eq).toHaveBeenCalledWith("email", "staffer@example.com");
  });

  it("bindBusinessMemberUser no-ops on empty email and throws on error", async () => {
    expect(await bindBusinessMemberUser("user-1", "  ")).toBe(0);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();

    const nullData = mockDb({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    expect(await bindBusinessMemberUser("user-1", "a@b.co", nullData as never)).toBe(0);

    const bad = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    await expect(bindBusinessMemberUser("user-1", "a@b.co", bad as never)).rejects.toThrow(
      "bindBusinessMemberUser: boom"
    );
  });

  describe("getBusinessRoleForEmail", () => {
    function twoStepDb(
      bizResult: { data?: unknown; error?: { message: string } | null },
      memberResult: { data?: unknown; error?: { message: string } | null } = { data: null, error: null }
    ) {
      return mockDb({
        maybeSingle: vi
          .fn()
          .mockResolvedValueOnce({ data: bizResult.data ?? null, error: bizResult.error ?? null })
          .mockResolvedValueOnce({
            data: memberResult.data ?? null,
            error: memberResult.error ?? null
          })
      });
    }

    it("returns null for an empty email without touching the DB", async () => {
      expect(await getBusinessRoleForEmail(BIZ, "  ")).toBeNull();
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
    });

    it("returns owner for the business owner_email (case-insensitive)", async () => {
      const db = twoStepDb({ data: { owner_email: " Owner@Example.com " } });
      expect(await getBusinessRoleForEmail(BIZ, "owner@EXAMPLE.com", db as never)).toBe("owner");
    });

    it("returns the active membership role", async () => {
      const db = twoStepDb(
        { data: { owner_email: "owner@example.com" } },
        { data: { role: "manager", status: "active" } }
      );
      expect(await getBusinessRoleForEmail(BIZ, "m@example.com", db as never)).toBe("manager");
    });

    it("counts invited (not yet bound) memberships too", async () => {
      const db = twoStepDb(
        { data: { owner_email: "owner@example.com" } },
        { data: { role: "staff", status: "invited" } }
      );
      expect(await getBusinessRoleForEmail(BIZ, "s@example.com", db as never)).toBe("staff");
    });

    it("returns null for revoked members, non-members, and missing businesses", async () => {
      const revoked = twoStepDb(
        { data: { owner_email: "owner@example.com" } },
        { data: { role: "staff", status: "revoked" } }
      );
      expect(await getBusinessRoleForEmail(BIZ, "s@example.com", revoked as never)).toBeNull();

      const noMember = twoStepDb({ data: { owner_email: "owner@example.com" } });
      expect(await getBusinessRoleForEmail(BIZ, "x@example.com", noMember as never)).toBeNull();

      const noBiz = twoStepDb({ data: null });
      expect(await getBusinessRoleForEmail(BIZ, "x@example.com", noBiz as never)).toBeNull();
    });

    it("handles a null owner_email business row", async () => {
      const db = twoStepDb(
        { data: { owner_email: null } },
        { data: { role: "staff", status: "active" } }
      );
      expect(await getBusinessRoleForEmail(BIZ, "s@example.com", db as never)).toBe("staff");
    });

    it("throws on lookup errors (both queries)", async () => {
      const bizErr = twoStepDb({ error: { message: "boom" } });
      await expect(getBusinessRoleForEmail(BIZ, "a@b.co", bizErr as never)).rejects.toThrow(
        "getBusinessRoleForEmail: boom"
      );

      const memErr = twoStepDb(
        { data: { owner_email: "owner@example.com" } },
        { error: { message: "kaboom" } }
      );
      await expect(getBusinessRoleForEmail(BIZ, "a@b.co", memErr as never)).rejects.toThrow(
        "getBusinessRoleForEmail: kaboom"
      );
    });

    it("falls back to the service client when none is provided", async () => {
      const db = twoStepDb({ data: { owner_email: "owner@example.com" } });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await getBusinessRoleForEmail(BIZ, "owner@example.com")).toBe("owner");
      expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    });
  });
});
