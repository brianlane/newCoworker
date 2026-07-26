import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/employees/manage-tool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/employees/manage-tool")>();
  return { ...actual, manageEmployee: vi.fn() };
});
vi.mock("@/lib/db/employees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/employees")>();
  return { ...actual, listTeamMembers: vi.fn() };
});

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  createEmployeeTool,
  listEmployeesTool,
  updateEmployeeTool
} from "@/lib/mcp/tools/employees";
import { manageEmployee } from "@/lib/employees/manage-tool";
import { listTeamMembers, type TeamMemberRow } from "@/lib/db/employees";

/**
 * Claude-connector roster tools. The roster decides who receives leads, so all
 * three sit at the manage_settings bar (the Employees page's own), and the two
 * writers delegate to the shared manageEmployee core rather than touching the
 * table, so a Claude edit behaves exactly like one made in the UI.
 */

const AUTH = { userId: "user-1", email: "owner@biz.com" };

function member(overrides: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: "m-1",
    business_id: "biz-1",
    name: "Amy Laidlaw",
    phone_e164: "+16026951142",
    email: null,
    active: true,
    last_offered_at: null,
    weekly_schedule: { mon: [["09:00", "17:00"]] },
    preferred_windows: null,
    routing_enabled: false,
    named_broadcast_enabled: true,
    team_broadcast_enabled: false,
    created_at: "2026-07-21T01:45:13Z",
    ...overrides
  };
}

const OK_RESULT = {
  ok: true as const,
  action: "add" as const,
  employee: {
    id: "m-2",
    name: "Sandy Reyes",
    phoneE164: "+16025550134",
    email: null,
    active: true,
    leadRotation: true,
    namedGroupOffers: true,
    wholeTeamOffers: true
  },
  note: "Tell the owner…"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner" as never);
  vi.mocked(manageEmployee).mockResolvedValue(OK_RESULT);
  vi.mocked(listTeamMembers).mockResolvedValue([member()]);
});

describe("list_employees (MCP)", () => {
  it("reports availability and schedules in the owner-facing form", async () => {
    const result = (await listEmployeesTool.handler({}, AUTH)) as {
      employees: Array<Record<string, unknown>>;
    };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(result.employees[0]).toEqual({
      name: "Amy Laidlaw",
      phone: "+16026951142",
      email: null,
      active: true,
      weekly_schedule: "mon 09:00-17:00",
      preferred_times: null,
      lead_rotation: false,
      named_group_offers: true,
      whole_team_offers: false
    });
  });

  it("reads a pre-migration row (null flags) as fully available", async () => {
    vi.mocked(listTeamMembers).mockResolvedValue([
      member({
        // No hours set either: "always available" reads as null, not "".
        weekly_schedule: null,
        routing_enabled: null as unknown as boolean,
        named_broadcast_enabled: null as unknown as boolean,
        team_broadcast_enabled: null as unknown as boolean
      })
    ]);
    const result = (await listEmployeesTool.handler({}, AUTH)) as {
      employees: Array<Record<string, unknown>>;
    };
    expect(result.employees[0]).toMatchObject({
      weekly_schedule: null,
      lead_rotation: true,
      named_group_offers: true,
      whole_team_offers: true
    });
  });
});

describe("create_employee (MCP)", () => {
  it("delegates to the shared core with every optional field mapped", async () => {
    const result = (await createEmployeeTool.handler(
      {
        business_id: "biz-9",
        name: "Sandy Reyes",
        phone: "602-555-0134",
        email: "sandy@example.com",
        weekly_schedule: "mon-fri 09:00-17:00",
        preferred_times: "mon 09:00-12:00",
        lead_rotation: false,
        named_group_offers: true,
        whole_team_offers: false
      },
      AUTH
    )) as { created: boolean };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-9", "manage_settings");
    expect(manageEmployee).toHaveBeenCalledWith("biz-9", {
      action: "add",
      name: "Sandy Reyes",
      phone: "602-555-0134",
      email: "sandy@example.com",
      scheduleText: "mon-fri 09:00-17:00",
      preferredText: "mon 09:00-12:00",
      leadRotation: false,
      namedGroupOffers: true,
      wholeTeamOffers: false
    });
    expect(result.created).toBe(true);
  });

  it("omits fields the caller left out, so column defaults apply", async () => {
    await createEmployeeTool.handler({ name: "Sandy", phone: "+16025550134" }, AUTH);
    expect(manageEmployee).toHaveBeenCalledWith("biz-1", {
      action: "add",
      name: "Sandy",
      phone: "+16025550134"
    });
  });

  it("turns a core refusal into a tool error instead of a silent success", async () => {
    vi.mocked(manageEmployee).mockResolvedValue({
      ok: false,
      message: "already_on_roster, +16025550134 is already Dave Lane."
    });
    await expect(
      createEmployeeTool.handler({ name: "Dave", phone: "+16025550134" }, AUTH)
    ).rejects.toThrow(/already_on_roster/);
  });

  it("a refused role check stops the write (staff must never edit the roster)", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValue(
      new McpToolError("Your role does not allow this.")
    );
    await expect(
      createEmployeeTool.handler({ name: "Sandy", phone: "+16025550134" }, AUTH)
    ).rejects.toThrow(/role does not allow/);
    expect(manageEmployee).not.toHaveBeenCalled();
  });
});

describe("update_employee (MCP)", () => {
  it("maps active=false to the deactivate action and carries edits with it", async () => {
    await updateEmployeeTool.handler(
      { employee: "Dave Lane", active: false, email: "" },
      AUTH
    );
    expect(manageEmployee).toHaveBeenCalledWith("biz-1", {
      action: "deactivate",
      employee: "Dave Lane",
      email: ""
    });
  });

  it("maps active=true to reactivate", async () => {
    await updateEmployeeTool.handler({ employee: "Dave Lane", active: true }, AUTH);
    expect(manageEmployee).toHaveBeenCalledWith("biz-1", {
      action: "reactivate",
      employee: "Dave Lane"
    });
  });

  it("is a plain update when active is untouched, and maps every field", async () => {
    const result = (await updateEmployeeTool.handler(
      {
        employee: "+16026951142",
        name: "Amy Laidlaw",
        phone: "+16026951143",
        weekly_schedule: "mon-fri 09:00-17:00",
        preferred_times: "",
        lead_rotation: false,
        named_group_offers: true,
        whole_team_offers: false
      },
      AUTH
    )) as { updated: boolean };
    expect(manageEmployee).toHaveBeenCalledWith("biz-1", {
      action: "update",
      employee: "+16026951142",
      name: "Amy Laidlaw",
      phone: "+16026951143",
      scheduleText: "mon-fri 09:00-17:00",
      preferredText: "",
      leadRotation: false,
      namedGroupOffers: true,
      wholeTeamOffers: false
    });
    expect(result.updated).toBe(true);
  });

  it("turns a core refusal into a tool error", async () => {
    vi.mocked(manageEmployee).mockResolvedValue({
      ok: false,
      message: 'ambiguous_employee, "Dave" matches two people.'
    });
    await expect(
      updateEmployeeTool.handler({ employee: "Dave", lead_rotation: false }, AUTH)
    ).rejects.toThrow(/ambiguous_employee/);
  });
});
