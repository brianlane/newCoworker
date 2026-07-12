import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  buildUserEngagementRows,
  listPlatformAuthUsers,
  quietOwnerBusinessIds,
  summarizeUserEngagement,
  AUTH_USERS_PER_PAGE,
  type PlatformAuthUser
} from "@/lib/admin/user-engagement";

const NOW = new Date("2026-07-11T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function user(email: string, overrides: Partial<PlatformAuthUser> = {}): PlatformAuthUser {
  return {
    email,
    created_at: daysAgo(200),
    last_sign_in_at: daysAgo(1),
    ...overrides
  };
}

const BIZ = {
  id: "biz-1",
  name: "Acme",
  owner_email: "Owner@Acme.com",
  created_at: daysAgo(120)
};

describe("buildUserEngagementRows", () => {
  it("emits owner rows keyed to auth data, classified by last sign-in recency", () => {
    const rows = buildUserEngagementRows(
      {
        users: [user("owner@acme.com", { last_sign_in_at: daysAgo(45) })],
        businesses: [BIZ],
        members: []
      },
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "owner@acme.com",
      businessId: "biz-1",
      businessName: "Acme",
      role: "owner",
      segment: "cooling"
    });
  });

  it("skips businesses with a blank owner email", () => {
    const rows = buildUserEngagementRows(
      {
        users: [],
        businesses: [{ ...BIZ, owner_email: "  " }],
        members: []
      },
      NOW
    );
    expect(rows).toEqual([]);
  });

  it("owner with no auth user falls back to the business dates (new when recent)", () => {
    const rows = buildUserEngagementRows(
      {
        users: [],
        businesses: [{ ...BIZ, created_at: daysAgo(5) }],
        members: []
      },
      NOW
    );
    expect(rows[0]).toMatchObject({ role: "owner", lastSignInAt: null, segment: "new" });
  });

  it("emits member rows (invite dates for never-signed-up members), skipping revoked", () => {
    const member = {
      business_id: "biz-1",
      email: "Staff@Acme.com",
      role: "staff",
      status: "invited",
      created_at: daysAgo(3)
    };
    const revoked = { ...member, email: "gone@acme.com", status: "revoked" };
    const rows = buildUserEngagementRows(
      { users: [], businesses: [BIZ], members: [member, revoked] },
      NOW
    );
    const memberRows = rows.filter((r) => r.role === "staff");
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]).toMatchObject({
      email: "staff@acme.com",
      businessName: "Acme",
      segment: "new"
    });
  });

  it("member of an unknown business gets a null business name", () => {
    const rows = buildUserEngagementRows(
      {
        users: [user("staff@x.com")],
        businesses: [],
        members: [
          {
            business_id: "missing",
            email: "staff@x.com",
            role: "manager",
            status: "active",
            created_at: daysAgo(10)
          }
        ]
      },
      NOW
    );
    expect(rows[0]).toMatchObject({ businessName: null, businessId: "missing", role: "manager" });
  });

  it("auth users linked to no business appear once with role none; linked users are not duplicated", () => {
    const rows = buildUserEngagementRows(
      {
        users: [user("owner@acme.com"), user("stray@nowhere.com", { last_sign_in_at: null, created_at: daysAgo(400) })],
        businesses: [BIZ],
        members: []
      },
      NOW
    );
    expect(rows.map((r) => `${r.email}:${r.role}`).sort()).toEqual([
      "owner@acme.com:owner",
      "stray@nowhere.com:none"
    ]);
    expect(rows.find((r) => r.role === "none")?.segment).toBe("quiet");
  });

  it("orders by last sign-in desc with never-signed-in rows last", () => {
    const rows = buildUserEngagementRows(
      {
        users: [
          user("old@x.com", { last_sign_in_at: daysAgo(20) }),
          user("fresh@x.com", { last_sign_in_at: daysAgo(1) }),
          user("never@x.com", { last_sign_in_at: null })
        ],
        businesses: [],
        members: []
      },
      NOW
    );
    expect(rows.map((r) => r.email)).toEqual(["fresh@x.com", "old@x.com", "never@x.com"]);
  });
});

describe("summarizeUserEngagement", () => {
  it("counts DAU/WAU/MAU windows and the daily engagement rate", () => {
    const summary = summarizeUserEngagement(
      [
        user("a@x.com", { last_sign_in_at: daysAgo(0.5) }),
        user("b@x.com", { last_sign_in_at: daysAgo(3) }),
        user("c@x.com", { last_sign_in_at: daysAgo(20) }),
        user("d@x.com", { last_sign_in_at: daysAgo(90) }),
        user("e@x.com", { last_sign_in_at: null })
      ],
      NOW
    );
    expect(summary).toEqual({
      totalUsers: 5,
      activeToday: 1,
      active7d: 2,
      active30d: 3,
      dailyEngagementRatePct: 20
    });
  });

  it("returns a 0% rate for an empty directory", () => {
    expect(summarizeUserEngagement([], NOW).dailyEngagementRatePct).toBe(0);
  });
});

describe("quietOwnerBusinessIds", () => {
  it("collects only quiet OWNER rows that carry a business id", () => {
    const rows = buildUserEngagementRows(
      {
        users: [
          user("owner@acme.com", { last_sign_in_at: daysAgo(120) }),
          user("staff@acme.com", { last_sign_in_at: daysAgo(120) })
        ],
        businesses: [BIZ],
        members: [
          {
            business_id: "biz-1",
            email: "staff@acme.com",
            role: "staff",
            status: "active",
            created_at: daysAgo(150)
          }
        ]
      },
      NOW
    );
    expect(quietOwnerBusinessIds(rows)).toEqual(new Set(["biz-1"]));

    const activeOwner = buildUserEngagementRows(
      { users: [user("owner@acme.com")], businesses: [BIZ], members: [] },
      NOW
    );
    expect(quietOwnerBusinessIds(activeOwner)).toEqual(new Set());
  });

  it("ignores a quiet owner row without a business id", () => {
    expect(
      quietOwnerBusinessIds([
        {
          email: "ghost@x.com",
          businessId: null,
          businessName: null,
          role: "owner",
          createdAt: daysAgo(200),
          lastSignInAt: null,
          segment: "quiet"
        }
      ])
    ).toEqual(new Set());
  });
});

describe("listPlatformAuthUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function authDb(pages: Array<Array<{ email?: string | null; created_at: string; last_sign_in_at?: string | null }>>, error: { message: string } | null = null) {
    const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => {
      if (error) return { data: null, error };
      return { data: { users: pages[page - 1] ?? [] }, error: null };
    });
    return { auth: { admin: { listUsers } }, listUsers };
  }

  it("collects users across pages until a short page, skipping email-less rows", async () => {
    const fullPage = Array.from({ length: AUTH_USERS_PER_PAGE }, (_, i) => ({
      email: `u${i}@x.com`,
      created_at: daysAgo(10),
      last_sign_in_at: null
    }));
    const db = authDb([
      fullPage,
      [
        { email: "last@x.com", created_at: daysAgo(1), last_sign_in_at: daysAgo(1) },
        { email: null, created_at: daysAgo(1) }
      ]
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const users = await listPlatformAuthUsers();
    expect(users).toHaveLength(AUTH_USERS_PER_PAGE + 1);
    expect(users.at(-1)).toEqual({
      email: "last@x.com",
      created_at: daysAgo(1),
      last_sign_in_at: daysAgo(1)
    });
    expect(db.listUsers).toHaveBeenCalledTimes(2);
  });

  it("accepts an injected client and stops on the first short page", async () => {
    const db = authDb([[{ email: "only@x.com", created_at: daysAgo(2) }]]);
    const users = await listPlatformAuthUsers(db as never);
    expect(users).toEqual([
      { email: "only@x.com", created_at: daysAgo(2), last_sign_in_at: null }
    ]);
    expect(db.listUsers).toHaveBeenCalledTimes(1);
  });

  it("treats a null data payload as an empty (final) page", async () => {
    const listUsers = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = { auth: { admin: { listUsers } } };
    expect(await listPlatformAuthUsers(db as never)).toEqual([]);
    expect(listUsers).toHaveBeenCalledTimes(1);
  });

  it("throws on a listUsers error", async () => {
    const db = authDb([], { message: "boom" });
    await expect(listPlatformAuthUsers(db as never)).rejects.toThrow(
      "listPlatformAuthUsers: boom"
    );
  });
});
