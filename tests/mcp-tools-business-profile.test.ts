import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/business-profile/update-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-profile/update-core")>();
  return { ...actual, applyBusinessProfileUpdate: vi.fn() };
});

import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { updateBusinessProfileTool } from "@/lib/mcp/tools/business-profile";
import { applyBusinessProfileUpdate } from "@/lib/business-profile/update-core";
import { runTool } from "./helpers/run-mcp-tool";

/**
 * update_business_profile: manage_settings-gated hours/timezone edits
 * through the shared Settings core. The description's hard negative (no
 * phone changes) is part of the contract, the model must be told, not
 * trusted to guess.
 */

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner" as never);
  vi.mocked(applyBusinessProfileUpdate).mockResolvedValue({
    ok: true,
    business_hours: { tue: { open: "11:00", close: "18:00" } },
    timezone: "America/Toronto"
  });
});

describe("update_business_profile (MCP)", () => {
  it("requires manage_settings and applies through the shared core", async () => {
    const result = (await runTool(
      updateBusinessProfileTool,
      { hours: { tue: { open: "11:00", close: "18:00" } }, timezone: "America/Toronto" },
      AUTH
    )) as { updated: boolean; timezone: string | null };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(applyBusinessProfileUpdate).toHaveBeenCalledWith("biz-1", {
      hours: { tue: { open: "11:00", close: "18:00" } },
      timezone: "America/Toronto"
    });
    expect(result).toEqual({
      updated: true,
      business_hours: { tue: { open: "11:00", close: "18:00" } },
      timezone: "America/Toronto"
    });
  });

  it("passes an explicit business_id through and omits absent fields", async () => {
    await runTool(
      updateBusinessProfileTool,
      { business_id: "22222222-2222-4222-8222-222222222222", timezone: "America/Phoenix" },
      AUTH
    );
    expect(resolveMcpBusinessId).toHaveBeenCalledWith(
      AUTH,
      "22222222-2222-4222-8222-222222222222"
    );
    expect(applyBusinessProfileUpdate).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      { timezone: "America/Phoenix" }
    );
  });

  it("surfaces core refusals as tool errors", async () => {
    vi.mocked(applyBusinessProfileUpdate).mockResolvedValue({
      ok: false,
      message: "Unknown timezone \"Mars/Olympus\"."
    });
    await expect(
      runTool(updateBusinessProfileTool, { timezone: "Mars/Olympus" }, AUTH)
    ).rejects.toThrow(/Unknown timezone/);
  });

  it("a refused role check propagates before the core runs", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValue(
      new McpToolError("Your role does not allow this.")
    );
    await expect(
      runTool(updateBusinessProfileTool, { timezone: "America/Phoenix" }, AUTH)
    ).rejects.toThrow(/role does not allow/);
    expect(applyBusinessProfileUpdate).not.toHaveBeenCalled();
  });

  it("declares hours and timezone only, no phone fields to fill", () => {
    const keys = Object.keys(updateBusinessProfileTool.schema);
    expect(keys.sort()).toEqual(["business_id", "hours", "timezone"]);
    // The hard negative is a description contract the bridge and connectors
    // both rely on: phone changes must be refused, not attempted.
    expect(updateBusinessProfileTool.description).toContain("can NOT change the business phone");
  });

  it("returns null hours/timezone shapes intact (schema holds them)", async () => {
    vi.mocked(applyBusinessProfileUpdate).mockResolvedValue({
      ok: true,
      business_hours: null,
      timezone: null
    });
    const result = (await runTool(
      updateBusinessProfileTool,
      { hours: { sun: null } },
      AUTH
    )) as { business_hours: unknown; timezone: unknown };
    expect(result.business_hours).toBeNull();
    expect(result.timezone).toBeNull();
    expect(applyBusinessProfileUpdate).toHaveBeenCalledWith("biz-1", { hours: { sun: null } });
  });
});
