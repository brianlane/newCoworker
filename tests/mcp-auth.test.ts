import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getClaimsMock = vi.fn();
const createClientMock = vi.fn(() => ({ auth: { getClaims: getClaimsMock } }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...(args as []))
}));

vi.mock("@/lib/db/business-members", () => ({
  getBusinessRoleForEmail: vi.fn()
}));
vi.mock("@/lib/dashboard/active-business", () => ({
  listAccessibleBusinesses: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() }
}));

import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId,
  toAuthUser,
  verifySupabaseAccessToken
} from "@/lib/mcp/auth";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { listAccessibleBusinesses } from "@/lib/dashboard/active-business";
import { logger } from "@/lib/logger";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

const VALID_CLAIMS = {
  sub: "user-1",
  role: "authenticated",
  email: "owner@biz.com"
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

describe("verifySupabaseAccessToken", () => {
  it("returns the caller for a valid authenticated token", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: VALID_CLAIMS }, error: null });
    expect(await verifySupabaseAccessToken("jwt")).toEqual(AUTH);
    expect(getClaimsMock).toHaveBeenCalledWith("jwt");
  });

  it("trims the email claim", async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { ...VALID_CLAIMS, email: "  owner@biz.com  " } },
      error: null
    });
    expect(await verifySupabaseAccessToken("jwt")).toEqual(AUTH);
  });

  it("returns null when supabase env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns null for an empty token", async () => {
    expect(await verifySupabaseAccessToken("")).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns null when verification errors", async () => {
    getClaimsMock.mockResolvedValue({ data: null, error: { message: "expired" } });
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();
  });

  it("returns null when claims are missing entirely", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: null }, error: null });
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();
  });

  it("rejects anon-role and malformed claims", async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { ...VALID_CLAIMS, role: "anon" } },
      error: null
    });
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();

    getClaimsMock.mockResolvedValue({
      data: { claims: { ...VALID_CLAIMS, sub: 42 } },
      error: null
    });
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();

    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: "user-1", role: 5, email: "owner@biz.com" } },
      error: null
    });
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();

    getClaimsMock.mockResolvedValue({
      data: { claims: { ...VALID_CLAIMS, email: undefined } },
      error: null
    });
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();
  });

  it("returns null when the client throws", async () => {
    getClaimsMock.mockRejectedValue(new Error("network down"));
    expect(await verifySupabaseAccessToken("jwt")).toBeNull();
  });
});

describe("toAuthUser", () => {
  it("maps to the AuthUser shape with isAdmin always false", () => {
    expect(toAuthUser(AUTH)).toEqual({
      userId: "user-1",
      email: "owner@biz.com",
      isAdmin: false
    });
  });
});

describe("requireMcpBusinessRole", () => {
  it("returns the role when the action is allowed", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("manager");
    await expect(
      requireMcpBusinessRole(AUTH, "biz-1", "manage_aiflows")
    ).resolves.toBe("manager");
    expect(getBusinessRoleForEmail).toHaveBeenCalledWith("biz-1", "owner@biz.com");
  });

  it("refuses when the caller has no role on the business", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null);
    await expect(
      requireMcpBusinessRole(AUTH, "biz-1", "view_dashboard")
    ).rejects.toBeInstanceOf(McpToolError);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp authorization refused",
      expect.objectContaining({ reason: "no_role" })
    );
  });

  it("refuses when the role is insufficient for the action", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("staff");
    await expect(
      requireMcpBusinessRole(AUTH, "biz-1", "manage_aiflows")
    ).rejects.toBeInstanceOf(McpToolError);
    expect(logger.warn).toHaveBeenCalledWith(
      "mcp authorization refused",
      expect.objectContaining({ reason: "role_staff_insufficient" })
    );
  });
});

describe("resolveMcpBusinessId", () => {
  it("returns an explicit business id untouched", async () => {
    expect(await resolveMcpBusinessId(AUTH, "biz-9")).toBe("biz-9");
    expect(listAccessibleBusinesses).not.toHaveBeenCalled();
  });

  it("returns the sole accessible business", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: "biz-1", name: "One", tier: "starter", role: "owner", created_at: "2026-01-01" }
    ]);
    expect(await resolveMcpBusinessId(AUTH)).toBe("biz-1");
  });

  it("errors when the account has no businesses", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([]);
    await expect(resolveMcpBusinessId(AUTH)).rejects.toThrow(/no businesses/);
  });

  it("errors and points at list_businesses when multiple are accessible", async () => {
    vi.mocked(listAccessibleBusinesses).mockResolvedValue([
      { businessId: "biz-1", name: "One", tier: "starter", role: "owner", created_at: "2026-01-01" },
      { businessId: "biz-2", name: "Two", tier: "standard", role: "manager", created_at: "2026-01-02" }
    ]);
    await expect(resolveMcpBusinessId(AUTH)).rejects.toThrow(/list_businesses/);
  });
});
