/**
 * list_system_logs MCP tool: fleet-wide for the HQ owner seat, tenant-scoped
 * for everyone else, filters passed through to listSystemLogsAll.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/db/business-members", () => ({
  getBusinessRoleForEmail: vi.fn()
}));
vi.mock("@/lib/db/system-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/system-logs")>();
  return {
    ...actual,
    listSystemLogsAll: vi.fn()
  };
});

import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { getBusinessRoleForEmail } from "@/lib/db/business-members";
import { listSystemLogsAll } from "@/lib/db/system-logs";
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";
import { listSystemLogsTool, systemLogTools } from "@/lib/mcp/tools/system-logs";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@hq.test" };
const OTHER_BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

function logRow(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    business_id: OTHER_BIZ,
    source: "email",
    level: "error",
    event: "email_delivery_failed",
    message: "Email was not delivered (bounced) to lead@trades.com.",
    payload: { to: "lead@trades.com", status: "bounced", errorCode: "550" },
    created_at: "2026-09-10T12:00:00.000Z",
    businesses: { name: "Trades Co" },
    ...over
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null);
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
  vi.mocked(resolveMcpBusinessId).mockImplementation(async (_auth, explicit?: string) => {
    return explicit ?? "biz-1";
  });
  vi.mocked(listSystemLogsAll).mockResolvedValue([logRow() as never]);
});

describe("the module exports the list tool", () => {
  it("is the only system-log tool", () => {
    expect(systemLogTools.map((t) => t.name)).toEqual(["list_system_logs"]);
  });
});

describe("list_system_logs authz", () => {
  it("HQ owner omitting business_id reads fleet-wide", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    const result = (await runTool(listSystemLogsTool, {}, AUTH)) as {
      scope: string;
      logs: Array<Record<string, unknown>>;
      next_before: string | null;
    };
    expect(getBusinessRoleForEmail).toHaveBeenCalledWith(HQ_BUSINESS_ID, AUTH.email);
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, HQ_BUSINESS_ID, "view_dashboard");
    expect(resolveMcpBusinessId).not.toHaveBeenCalled();
    expect(listSystemLogsAll).toHaveBeenCalledWith({
      event: undefined,
      search: undefined,
      level: undefined,
      minLevel: undefined,
      source: undefined,
      since: undefined,
      before: undefined,
      limit: 50,
      businessId: undefined
    });
    expect(result.scope).toBe("fleet");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({
      id: 11,
      event: "email_delivery_failed",
      business_id: OTHER_BIZ,
      business_name: "Trades Co",
      email: "lead@trades.com",
      domain: "trades.com",
      payload: { to: "lead@trades.com", status: "bounced", errorCode: "550" }
    });
    expect(result.next_before).toBeNull();
  });

  it("HQ owner may filter to a tenant they are not a member of", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    const result = (await runTool(listSystemLogsTool, { business_id: OTHER_BIZ }, AUTH)) as {
      scope: string;
    };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, HQ_BUSINESS_ID, "view_dashboard");
    expect(resolveMcpBusinessId).not.toHaveBeenCalled();
    expect(listSystemLogsAll).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: OTHER_BIZ, limit: 50 })
    );
    expect(result.scope).toBe("business");
  });

  it("a non-HQ seat is tenant-scoped and cannot skip business resolution", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("manager");
    await runTool(listSystemLogsTool, { business_id: "biz-1" }, AUTH);
    expect(resolveMcpBusinessId).toHaveBeenCalledWith(AUTH, "biz-1");
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "view_dashboard");
    expect(listSystemLogsAll).toHaveBeenCalledWith(expect.objectContaining({ businessId: "biz-1" }));
    const result = (await runTool(listSystemLogsTool, {}, AUTH)) as { scope: string };
    expect(result.scope).toBe("business");
  });

  it("a tenant with no HQ role still cannot read another business once requireMcpBusinessRole refuses", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue(null);
    vi.mocked(requireMcpBusinessRole).mockRejectedValue(
      new McpToolError(
        "You don't have permission to do that on this business. Ask the business owner to adjust your team role."
      )
    );
    await expect(runTool(listSystemLogsTool, { business_id: OTHER_BIZ }, AUTH)).rejects.toThrow(
      /don't have permission/
    );
    expect(listSystemLogsAll).not.toHaveBeenCalled();
  });
});

describe("list_system_logs filters", () => {
  it("passes event, search, level, minLevel, source, since, before, and limit through", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    await runTool(
      listSystemLogsTool,
      {
        event: "email_delivery_failed",
        search: "outreach",
        level: "error",
        minLevel: "warn",
        source: "email",
        since: "2026-09-01T00:00:00.000Z",
        before: "2026-09-10T00:00:00.000Z",
        limit: 25
      },
      AUTH
    );
    expect(listSystemLogsAll).toHaveBeenCalledWith({
      event: "email_delivery_failed",
      search: "outreach",
      level: "error",
      minLevel: "warn",
      source: "email",
      since: "2026-09-01T00:00:00.000Z",
      before: "2026-09-10T00:00:00.000Z",
      limit: 25,
      businessId: undefined
    });
  });

  it("refuses a non-ISO since or before", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    await expect(runTool(listSystemLogsTool, { since: "yesterday" }, AUTH)).rejects.toThrow(
      /since must be an ISO timestamp/
    );
    await expect(runTool(listSystemLogsTool, { before: "nope" }, AUTH)).rejects.toThrow(
      /before must be an ISO timestamp/
    );
    expect(listSystemLogsAll).not.toHaveBeenCalled();
  });

  it("returns next_before when the page is full", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    vi.mocked(listSystemLogsAll).mockResolvedValue([
      logRow({ id: 2, created_at: "2026-09-10T12:00:00.000Z" }),
      logRow({ id: 1, created_at: "2026-09-10T11:00:00.000Z" })
    ] as never);
    const result = (await runTool(listSystemLogsTool, { limit: 2 }, AUTH)) as {
      next_before: string | null;
    };
    expect(result.next_before).toBe("2026-09-10T11:00:00.000Z");
  });

  it("nulls business_name and email when the join and payload are empty", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    vi.mocked(listSystemLogsAll).mockResolvedValue([
      logRow({
        business_id: null,
        businesses: null,
        payload: {},
        message: "platform sweep finished"
      })
    ] as never);
    const result = (await runTool(listSystemLogsTool, {}, AUTH)) as {
      logs: Array<{ business_name: string | null; email: string | null; domain: string | null }>;
    };
    expect(result.logs[0].business_name).toBeNull();
    expect(result.logs[0].email).toBeNull();
    expect(result.logs[0].domain).toBeNull();
  });

  it("surfaces a query failure as a tool error, including a non-Error throw", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    vi.mocked(listSystemLogsAll).mockRejectedValue(new Error("listSystemLogsAll: boom"));
    await expect(runTool(listSystemLogsTool, {}, AUTH)).rejects.toThrow(
      /Could not load system logs: listSystemLogsAll: boom/
    );
    vi.mocked(listSystemLogsAll).mockRejectedValue("down");
    await expect(runTool(listSystemLogsTool, {}, AUTH)).rejects.toThrow(
      /Could not load system logs: down/
    );
  });

  it("defaults payload to {} when the row has none", async () => {
    vi.mocked(getBusinessRoleForEmail).mockResolvedValue("owner");
    vi.mocked(listSystemLogsAll).mockResolvedValue([
      logRow({ payload: undefined, message: "x" })
    ] as never);
    const result = (await runTool(listSystemLogsTool, {}, AUTH)) as {
      logs: Array<{ payload: Record<string, unknown> }>;
    };
    expect(result.logs[0].payload).toEqual({});
  });
});
