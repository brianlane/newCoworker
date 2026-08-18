import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/knowledge-tools/identity-sections", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/knowledge-tools/identity-sections")
  >();
  return {
    ...actual,
    readBusinessKnowledge: vi.fn(),
    updateBusinessKnowledgeCore: vi.fn()
  };
});

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  getBusinessKnowledgeTool,
  updateBusinessKnowledgeTool
} from "@/lib/mcp/tools/business-knowledge";
import {
  readBusinessKnowledge,
  updateBusinessKnowledgeCore
} from "@/lib/knowledge-tools/identity-sections";
import { runTool } from "./helpers/run-mcp-tool";

/**
 * get/update_business_knowledge: OWNER-ONLY twice over, the handler
 * requires the literal owner role on top of manage_settings, because the
 * identity document is the coworker's voice, and a manager editing it is a
 * different decision than the owner making their own coworker say things.
 */

const AUTH = { userId: "user-1", email: "owner@biz.com" };

const SECTIONS = [
  { index: 0, heading: null, content: "Intro." },
  { index: 1, heading: "Pricing", content: "## Pricing\nConsults are free." }
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner" as never);
  vi.mocked(readBusinessKnowledge).mockResolvedValue({
    sections: SECTIONS,
    total_chars: 42
  });
  vi.mocked(updateBusinessKnowledgeCore).mockResolvedValue({
    ok: true,
    sections: SECTIONS,
    total_chars: 42
  });
});

describe("get_business_knowledge (MCP)", () => {
  it("answers the sections for the owner", async () => {
    const result = (await runTool(getBusinessKnowledgeTool, {}, AUTH)) as {
      sections: unknown[];
      total_chars: number;
    };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_settings");
    expect(result.sections).toHaveLength(2);
    expect(result.total_chars).toBe(42);
  });

  it("refuses a manager even though manage_settings passed", async () => {
    vi.mocked(requireMcpBusinessRole).mockResolvedValue("manager" as never);
    await expect(runTool(getBusinessKnowledgeTool, {}, AUTH)).rejects.toThrow(
      /Only the business owner/
    );
    expect(readBusinessKnowledge).not.toHaveBeenCalled();
  });
});

describe("update_business_knowledge (MCP)", () => {
  it("applies a heading-addressed replace through the core", async () => {
    const result = (await runTool(
      updateBusinessKnowledgeTool,
      { mode: "replace", section_heading: "Pricing", content: "Consults are $150." },
      AUTH
    )) as { updated: boolean };
    expect(updateBusinessKnowledgeCore).toHaveBeenCalledWith("biz-1", {
      mode: "replace",
      sectionHeading: "Pricing",
      content: "Consults are $150."
    });
    expect(result.updated).toBe(true);
  });

  it("applies an index-addressed replace and an append", async () => {
    await runTool(
      updateBusinessKnowledgeTool,
      { mode: "replace", section_index: 0, content: "New intro." },
      AUTH
    );
    expect(updateBusinessKnowledgeCore).toHaveBeenCalledWith("biz-1", {
      mode: "replace",
      sectionIndex: 0,
      content: "New intro."
    });
    await runTool(
      updateBusinessKnowledgeTool,
      { mode: "append_section", content: "## Hours\nMon-Fri" },
      AUTH
    );
    expect(updateBusinessKnowledgeCore).toHaveBeenLastCalledWith("biz-1", {
      mode: "append_section",
      content: "## Hours\nMon-Fri"
    });
  });

  it("surfaces splice refusals as tool errors", async () => {
    vi.mocked(updateBusinessKnowledgeCore).mockResolvedValue({
      ok: false,
      message: 'No section named "Refunds". Sections: 0: (intro before the first heading).'
    });
    await expect(
      runTool(
        updateBusinessKnowledgeTool,
        { mode: "replace", section_heading: "Refunds", content: "x" },
        AUTH
      )
    ).rejects.toThrow(/No section named/);
  });

  it("refuses a manager before the core runs (owner-only write)", async () => {
    vi.mocked(requireMcpBusinessRole).mockResolvedValue("manager" as never);
    await expect(
      runTool(
        updateBusinessKnowledgeTool,
        { mode: "append_section", content: "## X\ny" },
        AUTH
      )
    ).rejects.toThrow(/Only the business owner/);
    expect(updateBusinessKnowledgeCore).not.toHaveBeenCalled();
  });

  it("a refused role check propagates unchanged", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValue(
      new McpToolError("You don't have permission to do that on this business.")
    );
    await expect(runTool(getBusinessKnowledgeTool, {}, AUTH)).rejects.toThrow(/permission/);
  });

  it("declares no whole-document argument (splice-only by construction)", () => {
    const keys = Object.keys(updateBusinessKnowledgeTool.schema).sort();
    expect(keys).toEqual([
      "business_id",
      "content",
      "mode",
      "section_heading",
      "section_index"
    ]);
  });
});
