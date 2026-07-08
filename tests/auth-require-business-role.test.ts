import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/business-members", () => ({
  getBusinessRoleForEmail: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { logger } from "@/lib/logger";
import { requireBusinessRole } from "@/lib/auth";

const BIZ = "11111111-1111-4111-8111-111111111111";

function signIn(user: Record<string, unknown> | null) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) }
  } as never);
}

describe("requireBusinessRole", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, ADMIN_EMAIL: "admin@newcoworker.com" };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("throws 401 when unauthenticated", async () => {
    signIn(null);
    const err = await requireBusinessRole(BIZ, "view_dashboard").catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(401);
  });

  it("passes the platform admin without a role lookup", async () => {
    signIn({ id: "admin-1", email: "admin@newcoworker.com" });
    const user = await requireBusinessRole(BIZ, "manage_billing");
    expect(user.isAdmin).toBe(true);
    expect(getBusinessRoleForEmail).not.toHaveBeenCalled();
  });

  it("refuses (403 + security log) when the user has no email", async () => {
    signIn({ id: "u-1", email: undefined });
    const err = await requireBusinessRole(BIZ, "view_dashboard").catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(logger.warn).toHaveBeenCalledWith(
      "authorization refused",
      expect.objectContaining({ businessId: BIZ, action: "view_dashboard", reason: "no_email" })
    );
  });

  it("refuses when the user has no role on the business", async () => {
    signIn({ id: "u-1", email: "stranger@example.com" });
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null);
    const err = await requireBusinessRole(BIZ, "view_dashboard").catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(logger.warn).toHaveBeenCalledWith(
      "authorization refused",
      expect.objectContaining({ reason: "no_role" })
    );
  });

  it("refuses when the role is insufficient for the action", async () => {
    signIn({ id: "u-1", email: "staffer@example.com" });
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("staff");
    const err = await requireBusinessRole(BIZ, "manage_team").catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(logger.warn).toHaveBeenCalledWith(
      "authorization refused",
      expect.objectContaining({ reason: "role_staff_insufficient" })
    );
  });

  it("passes a manager for manager-level actions but not billing", async () => {
    signIn({ id: "u-1", email: "manager@example.com" });
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("manager");
    const user = await requireBusinessRole(BIZ, "manage_team");
    expect(user.userId).toBe("u-1");

    const err = await requireBusinessRole(BIZ, "manage_billing").catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
  });

  it("passes the owner for everything", async () => {
    signIn({ id: "u-1", email: "owner@example.com" });
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    await expect(requireBusinessRole(BIZ, "manage_billing")).resolves.toMatchObject({
      userId: "u-1"
    });
    expect(getBusinessRoleForEmail).toHaveBeenCalledWith(BIZ, "owner@example.com");
  });

  it("passes staff for operate-level actions", async () => {
    signIn({ id: "u-1", email: "staffer@example.com" });
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("staff");
    await expect(requireBusinessRole(BIZ, "operate_messages")).resolves.toMatchObject({
      userId: "u-1"
    });
  });
});
