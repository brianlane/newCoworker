import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAuthUser, requireAuth, requireAdmin, requireOwner } from "@/lib/auth";

function mockSupabase(user: Record<string, unknown> | null, error: unknown = null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error })
    },
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: user ? { id: "biz-1" } : null })
  };
}

describe("auth", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, ADMIN_EMAIL: "admin@newcoworker.com" };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("getAuthUser returns null when no session", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase(null) as never
    );
    const result = await getAuthUser();
    expect(result).toBeNull();
  });

  it("getAuthUser returns null on error", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase(null, new Error("Session expired")) as never
    );
    const result = await getAuthUser();
    expect(result).toBeNull();
  });

  it("getAuthUser returns user with isAdmin=false for regular user", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "user-1", email: "user@test.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.userId).toBe("user-1");
    expect(result?.isAdmin).toBe(false);
  });

  it("getAuthUser returns isAdmin=true for admin email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "admin@newcoworker.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.isAdmin).toBe(true);
  });

  it("getAuthUser returns null email when user has no email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-no-email", email: undefined }) as never
    );
    const result = await getAuthUser();
    expect(result?.email).toBeNull();
    expect(result?.isAdmin).toBe(false);
  });

  it("getAuthUser is case-insensitive for admin email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "ADMIN@NEWCOWORKER.COM" }) as never
    );
    const result = await getAuthUser();
    expect(result?.isAdmin).toBe(true);
  });

  it("getAuthUser returns isAdmin=false when ADMIN_EMAIL not set", async () => {
    delete process.env.ADMIN_EMAIL;
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u", email: "any@test.com" }) as never
    );
    const result = await getAuthUser();
    expect(result?.isAdmin).toBe(false);
  });

  it("requireAuth throws 401 when no user", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase(null) as never
    );
    await expect(requireAuth()).rejects.toMatchObject({ status: 401 });
  });

  it("requireAuth returns user when authenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "u@test.com" }) as never
    );
    const user = await requireAuth();
    expect(user.userId).toBe("u-1");
  });

  it("requireAdmin throws 403 for non-admin", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "regular@test.com" }) as never
    );
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("requireAdmin succeeds for admin email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "admin@newcoworker.com" }) as never
    );
    const user = await requireAdmin();
    expect(user.isAdmin).toBe(true);
  });

  it("requireOwner skips DB check for admin", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "admin-1", email: "admin@newcoworker.com" }) as never
    );
    const user = await requireOwner("some-biz-id");
    expect(user.isAdmin).toBe(true);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("requireOwner throws 403 when user has null email", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-no-email", email: undefined }) as never
    );
    await expect(requireOwner("biz-1")).rejects.toMatchObject({ status: 403 });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("requireOwner throws 403 for non-owner", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "u-1", email: "notowner@test.com" }) as never
    );
    const mockServiceDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockServiceDb as never);

    await expect(requireOwner("biz-1")).rejects.toMatchObject({ status: 403 });
  });

  it("requireOwner returns user for verified owner", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue(
      mockSupabase({ id: "owner-1", email: "owner@test.com" }) as never
    );
    const mockServiceDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: "biz-1" }, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockServiceDb as never);

    const user = await requireOwner("biz-1");
    expect(user.userId).toBe("owner-1");
  });

  it("getAuthUser handles throw in createSupabaseServerClient", async () => {
    vi.mocked(createSupabaseServerClient).mockRejectedValue(new Error("env missing"));
    const result = await getAuthUser();
    expect(result).toBeNull();
  });
});
