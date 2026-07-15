import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/agents/db", () => ({
  listBusinessAgents: vi.fn(),
  countBusinessAgents: vi.fn(),
  insertBusinessAgent: vi.fn(),
  getBusinessAgent: vi.fn(),
  patchBusinessAgent: vi.fn(),
  deleteBusinessAgent: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  createAgentTool,
  deleteAgentTool,
  listAgentsTool,
  updateAgentTool
} from "@/lib/mcp/tools/agents";
import {
  countBusinessAgents,
  deleteBusinessAgent,
  getBusinessAgent,
  insertBusinessAgent,
  listBusinessAgents,
  patchBusinessAgent
} from "@/lib/agents/db";
import { getBusiness } from "@/lib/db/businesses";

const AUTH = { userId: "user-1", email: "owner@biz.com" };
const AGENT_ID = "9c1a2f34-0000-4000-8000-000000000009";

const AGENT = {
  id: AGENT_ID,
  business_id: "biz-1",
  name: "Invoice extractor",
  instructions: "Extract line items",
  output_format: "markdown",
  enabled: true,
  created_at: "2026-07-01",
  updated_at: "2026-07-02"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
});

describe("list_agents", () => {
  it("lists the business's agents", async () => {
    vi.mocked(listBusinessAgents).mockResolvedValue([AGENT as never]);
    const result = (await listAgentsTool.handler({}, AUTH)) as { agents: unknown[] };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_aiflows");
    expect(result.agents).toEqual([
      {
        agent_id: AGENT_ID,
        name: "Invoice extractor",
        instructions: "Extract line items",
        output_format: "markdown",
        enabled: true,
        updated_at: "2026-07-02"
      }
    ]);
  });
});

describe("create_agent", () => {
  it("creates under the tier cap with the default output format", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ tier: "standard" } as never);
    vi.mocked(countBusinessAgents).mockResolvedValue(3);
    vi.mocked(insertBusinessAgent).mockResolvedValue(AGENT as never);
    const result = await createAgentTool.handler(
      { name: "Invoice extractor", instructions: "Extract line items" },
      AUTH
    );
    expect(insertBusinessAgent).toHaveBeenCalledWith({
      business_id: "biz-1",
      name: "Invoice extractor",
      instructions: "Extract line items",
      output_format: "markdown"
    });
    expect(result).toEqual({ created: true, agent_id: AGENT_ID, name: "Invoice extractor" });
  });

  it("honors an explicit output format", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ tier: "standard" } as never);
    vi.mocked(countBusinessAgents).mockResolvedValue(0);
    vi.mocked(insertBusinessAgent).mockResolvedValue(AGENT as never);
    await createAgentTool.handler(
      { name: "n", instructions: "i", output_format: "same_as_input" },
      AUTH
    );
    expect(insertBusinessAgent).toHaveBeenCalledWith(
      expect.objectContaining({ output_format: "same_as_input" })
    );
  });

  it("refuses at the cap (starter default when the business row is missing)", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    vi.mocked(countBusinessAgents).mockResolvedValue(5); // starter cap
    await expect(
      createAgentTool.handler({ name: "n", instructions: "i" }, AUTH)
    ).rejects.toThrow(/Agent limit reached \(5/);
    expect(insertBusinessAgent).not.toHaveBeenCalled();
  });
});

describe("update_agent", () => {
  it("refuses an empty patch", async () => {
    await expect(
      updateAgentTool.handler({ agent_id: AGENT_ID }, AUTH)
    ).rejects.toThrow(/Nothing to update/);
    expect(getBusinessAgent).not.toHaveBeenCalled();
  });

  it("errors when the agent does not exist", async () => {
    vi.mocked(getBusinessAgent).mockResolvedValue(null);
    await expect(
      updateAgentTool.handler({ agent_id: AGENT_ID, enabled: false }, AUTH)
    ).rejects.toThrow(/Agent not found/);
    expect(patchBusinessAgent).not.toHaveBeenCalled();
  });

  it("patches only the supplied fields", async () => {
    vi.mocked(getBusinessAgent).mockResolvedValue(AGENT as never);
    await updateAgentTool.handler({ agent_id: AGENT_ID, enabled: false }, AUTH);
    expect(patchBusinessAgent).toHaveBeenCalledWith("biz-1", AGENT_ID, { enabled: false });

    await updateAgentTool.handler(
      {
        agent_id: AGENT_ID,
        name: "Renamed",
        instructions: "New",
        output_format: "markdown"
      },
      AUTH
    );
    expect(patchBusinessAgent).toHaveBeenLastCalledWith("biz-1", AGENT_ID, {
      name: "Renamed",
      instructions: "New",
      output_format: "markdown"
    });
  });
});

describe("delete_agent", () => {
  it("errors when the agent does not exist", async () => {
    vi.mocked(getBusinessAgent).mockResolvedValue(null);
    await expect(
      deleteAgentTool.handler({ agent_id: AGENT_ID }, AUTH)
    ).rejects.toThrow(/Agent not found/);
    expect(deleteBusinessAgent).not.toHaveBeenCalled();
  });

  it("deletes an existing agent", async () => {
    vi.mocked(getBusinessAgent).mockResolvedValue(AGENT as never);
    const result = await deleteAgentTool.handler({ agent_id: AGENT_ID }, AUTH);
    expect(deleteBusinessAgent).toHaveBeenCalledWith("biz-1", AGENT_ID);
    expect(result).toEqual({ deleted: true, agent_id: AGENT_ID });
  });
});
