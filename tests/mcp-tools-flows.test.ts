import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
// Mutable override so tests can steer what get_flow_schema derives its JSON
// Schema from (a real zod schema = success; a non-schema = the catch branch).
const schemaHolder = vi.hoisted(() => ({ override: null as unknown }));
vi.mock("@/lib/ai-flows/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-flows/schema")>();
  return {
    ...actual,
    parseAiFlowDefinition: vi.fn(),
    get aiFlowDefinitionSchema() {
      return schemaHolder.override ?? actual.aiFlowDefinitionSchema;
    }
  };
});
vi.mock("@/lib/ai-flows/document-steps", () => ({ validateShareDocumentSteps: vi.fn() }));
vi.mock("@/lib/ai-flows/agent-steps", () => ({ validateRunAgentSteps: vi.fn() }));
vi.mock("@/lib/ai-flows/mailbox-steps", () => ({ validateMailboxConnectionSteps: vi.fn() }));
vi.mock("@/lib/ai-flows/db", () => ({
  listAiFlows: vi.fn(),
  getAiFlow: vi.fn(),
  createAiFlow: vi.fn(),
  updateAiFlow: vi.fn()
}));
vi.mock("@/lib/ai-flows/webhook-events", () => ({ processWebhookFlowEvent: vi.fn() }));
vi.mock("@/lib/ai-flows/manual-run-tool", () => ({ runAiFlowTool: vi.fn() }));
vi.mock("@/lib/ai-flows/versions", () => ({
  listFlowVersions: vi.fn(),
  restoreFlowVersion: vi.fn()
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  createFlowTool,
  getFlowSchemaTool,
  getFlowTool,
  listFlowsTool,
  runFlowTool,
  listFlowVersionsTool,
  restoreFlowVersionTool,
  setFlowEnabledTool,
  triggerFlowTool,
  updateFlowTool,
  validateFlowDefinition
} from "@/lib/mcp/tools/flows";
import {
  AiFlowValidationError,
  FLOW_STEP_TYPES,
  parseAiFlowDefinition,
  TRIGGER_CHANNELS
} from "@/lib/ai-flows/schema";
import { validateShareDocumentSteps } from "@/lib/ai-flows/document-steps";
import { validateRunAgentSteps } from "@/lib/ai-flows/agent-steps";
import { validateMailboxConnectionSteps } from "@/lib/ai-flows/mailbox-steps";
import { createAiFlow, getAiFlow, listAiFlows, updateAiFlow } from "@/lib/ai-flows/db";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { runAiFlowTool } from "@/lib/ai-flows/manual-run-tool";
import { listFlowVersions, restoreFlowVersion } from "@/lib/ai-flows/versions";
import { rateLimit } from "@/lib/rate-limit";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@biz.com" };
const FLOW_ID = "7d1a2f34-0000-4000-8000-000000000001";

const DEFINITION = {
  version: 1,
  trigger: { channel: "webhook" },
  steps: [{ id: "s1", type: "notify_owner" }]
};

const FLOW_ROW = {
  id: FLOW_ID,
  business_id: "biz-1",
  name: "Lead intake",
  enabled: true,
  definition: DEFINITION,
  created_by: null,
  created_at: "2026-07-01",
  updated_at: "2026-07-02"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
  vi.mocked(parseAiFlowDefinition).mockReturnValue(DEFINITION as never);
  vi.mocked(validateShareDocumentSteps).mockResolvedValue([]);
  vi.mocked(validateRunAgentSteps).mockResolvedValue([]);
  vi.mocked(validateMailboxConnectionSteps).mockResolvedValue([]);
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 1, remaining: 1, reset: 0 });
});

describe("validateFlowDefinition", () => {
  it("passes a valid definition through every validation layer", async () => {
    await expect(validateFlowDefinition("biz-1", DEFINITION)).resolves.toBeUndefined();
    expect(validateShareDocumentSteps).toHaveBeenCalledWith("biz-1", DEFINITION);
    expect(validateRunAgentSteps).toHaveBeenCalledWith("biz-1", DEFINITION);
    expect(validateMailboxConnectionSteps).toHaveBeenCalledWith("biz-1", DEFINITION);
  });

  it("converts shape errors into tool errors pointing at get_flow_schema", async () => {
    vi.mocked(parseAiFlowDefinition).mockImplementation(() => {
      throw new AiFlowValidationError("Invalid AiFlow definition", ["steps required"]);
    });
    await expect(validateFlowDefinition("biz-1", {})).rejects.toThrow(
      /steps required.*get_flow_schema/s
    );
  });

  it("rethrows non-validation failures", async () => {
    vi.mocked(parseAiFlowDefinition).mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(validateFlowDefinition("biz-1", {})).rejects.toThrow("db down");
  });

  it("refuses definitions with document/agent/mailbox binding issues", async () => {
    vi.mocked(validateShareDocumentSteps).mockResolvedValue(["doc missing"]);
    vi.mocked(validateRunAgentSteps).mockResolvedValue(["agent disabled"]);
    vi.mocked(validateMailboxConnectionSteps).mockResolvedValue(["mailbox gone"]);
    await expect(validateFlowDefinition("biz-1", DEFINITION)).rejects.toThrow(
      /doc missing; agent disabled; mailbox gone/
    );
  });
});

describe("list_flows / get_flow", () => {
  it("lists flows with trigger channel and step count", async () => {
    vi.mocked(listAiFlows).mockResolvedValue([FLOW_ROW as never]);
    const result = (await runTool(listFlowsTool, {}, AUTH)) as { flows: unknown[] };
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_aiflows");
    expect(result.flows).toEqual([
      {
        flow_id: FLOW_ID,
        name: "Lead intake",
        enabled: true,
        trigger_channel: "webhook",
        step_count: 1,
        updated_at: "2026-07-02"
      }
    ]);
  });

  it("returns one flow's full definition", async () => {
    vi.mocked(getAiFlow).mockResolvedValue(FLOW_ROW as never);
    const result = (await runTool(getFlowTool, { flow_id: FLOW_ID }, AUTH)) as {
      definition: unknown;
    };
    expect(result.definition).toEqual(DEFINITION);
  });

  it("errors on an unknown flow", async () => {
    vi.mocked(getAiFlow).mockResolvedValue(null);
    await expect(runTool(getFlowTool, { flow_id: FLOW_ID }, AUTH)).rejects.toThrow(
      /Flow not found/
    );
  });
});

describe("get_flow_schema", () => {
  it("returns the vocabulary plus the derived JSON Schema", async () => {
    schemaHolder.override = z.object({ version: z.literal(1) });
    try {
      const result = (await runTool(getFlowSchemaTool, {}, AUTH)) as {
        step_types: readonly string[];
        trigger_channels: readonly string[];
        json_schema: { type?: string } | null;
      };
      expect(result.step_types).toEqual(FLOW_STEP_TYPES);
      expect(result.trigger_channels).toEqual(TRIGGER_CHANNELS);
      expect(result.json_schema?.type).toBe("object");
    } finally {
      schemaHolder.override = null;
    }
  });

  it("degrades to a null json_schema when derivation throws", async () => {
    schemaHolder.override = 42; // not a zod schema → z.toJSONSchema throws
    try {
      const result = (await runTool(getFlowSchemaTool, {}, AUTH)) as {
        json_schema: unknown;
      };
      expect(result.json_schema).toBeNull();
    } finally {
      schemaHolder.override = null;
    }
  });
});

describe("create_flow / update_flow / set_flow_enabled", () => {
  it("creates a validated flow attributed to the caller, DISABLED by default", async () => {
    vi.mocked(createAiFlow).mockResolvedValue({ ...FLOW_ROW, enabled: false } as never);
    const result = await runTool(createFlowTool, 
      { name: "Lead intake", definition: DEFINITION },
      AUTH
    );
    // createAiFlow's own default is enabled:true, the connector must opt
    // model-authored flows OUT unless the caller explicitly enables them.
    expect(createAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      name: "Lead intake",
      enabled: false,
      definition: DEFINITION,
      createdBy: "user-1"
    });
    expect(result).toEqual({
      created: true,
      flow_id: FLOW_ID,
      name: "Lead intake",
      enabled: false
    });
  });

  it("honors an explicit enabled:true on create", async () => {
    vi.mocked(createAiFlow).mockResolvedValue(FLOW_ROW as never);
    await runTool(createFlowTool, 
      { name: "Lead intake", enabled: true, definition: DEFINITION },
      AUTH
    );
    expect(createAiFlow).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it("refuses an update with nothing to change", async () => {
    await expect(runTool(updateFlowTool, { flow_id: FLOW_ID }, AUTH)).rejects.toThrow(
      /Nothing to update/
    );
    expect(updateAiFlow).not.toHaveBeenCalled();
  });

  it("renames without re-validating a definition", async () => {
    vi.mocked(updateAiFlow).mockResolvedValue(FLOW_ROW as never);
    await runTool(updateFlowTool, { flow_id: FLOW_ID, name: "Renamed" }, AUTH);
    expect(parseAiFlowDefinition).not.toHaveBeenCalled();
    expect(updateAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      id: FLOW_ID,
      name: "Renamed",
      editSource: "mcp",
      editActor: "user-1"
    });
  });

  it("validates a replacement definition before persisting", async () => {
    vi.mocked(updateAiFlow).mockResolvedValue(FLOW_ROW as never);
    const result = await runTool(updateFlowTool, 
      { flow_id: FLOW_ID, definition: DEFINITION },
      AUTH
    );
    expect(parseAiFlowDefinition).toHaveBeenCalledWith(DEFINITION);
    expect(updateAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      id: FLOW_ID,
      definition: DEFINITION,
      // Stamped so the definition history can say a connector made this
      // whole-definition replace, not the owner in the dashboard.
      editSource: "mcp",
      editActor: "user-1"
    });
    expect(result).toMatchObject({ updated: true, flow_id: FLOW_ID });
  });

  it("toggles enabled", async () => {
    vi.mocked(updateAiFlow).mockResolvedValue({ ...FLOW_ROW, enabled: false } as never);
    const result = await runTool(setFlowEnabledTool, 
      { flow_id: FLOW_ID, enabled: false },
      AUTH
    );
    expect(updateAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      id: FLOW_ID,
      enabled: false
    });
    expect(result).toEqual({ flow_id: FLOW_ID, enabled: false });
  });
});

describe("trigger_flow", () => {
  it("enqueues matching webhook flows", async () => {
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 2,
      flowsEvaluated: 3,
      flowsMatched: 2
    } as never);
    const result = await runTool(triggerFlowTool, 
      { source: " zapier ", event_id: "evt-1", data: { name: "Ann" } },
      AUTH
    );
    expect(processWebhookFlowEvent).toHaveBeenCalledWith("biz-1", {
      source: "zapier",
      data: { name: "Ann" },
      eventId: "evt-1"
    });
    expect(result).toEqual({ enqueued: 2, flows_evaluated: 3, flows_matched: 2 });
  });

  it("defaults the source to webhook", async () => {
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 0,
      flowsEvaluated: 0,
      flowsMatched: 0
    } as never);
    await runTool(triggerFlowTool, { data: {} }, AUTH);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ source: "webhook" })
    );
  });

  it("refuses oversized payloads before rate limiting", async () => {
    const big = { blob: "x".repeat(65 * 1024) };
    await expect(runTool(triggerFlowTool, { data: big }, AUTH)).rejects.toThrow(/64KB max/);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("refuses when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 1, remaining: 0, reset: 0 });
    await expect(runTool(triggerFlowTool, { data: {} }, AUTH)).rejects.toBeInstanceOf(
      McpToolError
    );
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });

  it("surfaces the upgrade message when the tier gate refuses the event", async () => {
    // trigger_flow simulates an EXTERNAL webhook delivery, so a starter
    // business gets the same refusal a real bridge would.
    vi.mocked(processWebhookFlowEvent).mockResolvedValue({
      enqueued: 0,
      flowsEvaluated: 0,
      flowsMatched: 0,
      tierBlocked: true
    } as never);
    await expect(runTool(triggerFlowTool, { data: {} }, AUTH)).rejects.toThrow(/Standard plan/);
  });
});

/**
 * run_flow: the manual-run companion to trigger_flow. trigger_flow only ever
 * reaches WEBHOOK-triggered flows, so a manual flow (an owner's lead-intake,
 * say) was unreachable from Claude entirely.
 */
describe("run_flow", () => {
  it("runs a flow by reference through the shared manual-run core", async () => {
    vi.mocked(runAiFlowTool).mockResolvedValue({
      ok: true,
      runId: "run-9",
      flowName: "New Lead Intake",
      note: "Run enqueued."
    } as never);
    const result = await runTool(runFlowTool, 
      { flow: "New Lead Intake", input: "Jane +16025551212 wants a quote" },
      AUTH
    );
    expect(runAiFlowTool).toHaveBeenCalledWith("biz-1", {
      flow: "New Lead Intake",
      input: "Jane +16025551212 wants a quote"
    });
    expect(result).toEqual({
      run_id: "run-9",
      flow_name: "New Lead Intake",
      note: "Run enqueued."
    });
  });

  it("omits input when none was given", async () => {
    vi.mocked(runAiFlowTool).mockResolvedValue({
      ok: true,
      runId: "run-10",
      flowName: "F",
      note: "n"
    } as never);
    await runTool(runFlowTool, { flow: "F" }, AUTH);
    expect(runAiFlowTool).toHaveBeenCalledWith("biz-1", { flow: "F" });
  });

  it("surfaces a core refusal (disabled / unknown / voice-only) as a tool error", async () => {
    vi.mocked(runAiFlowTool).mockResolvedValue({
      ok: false,
      message: '"Voice routing" is a voice flow'
    } as never);
    await expect(runTool(runFlowTool, { flow: "Voice routing" }, AUTH)).rejects.toThrow(
      /is a voice flow/
    );
  });

  it("requires the manage_aiflows role", async () => {
    vi.mocked(runAiFlowTool).mockResolvedValue({
      ok: true,
      runId: "r",
      flowName: "F",
      note: "n"
    } as never);
    await runTool(runFlowTool, { flow: "F" }, AUTH);
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_aiflows");
  });

  it("refuses when rate limited, before any run is enqueued", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 1, remaining: 0, reset: 0 });
    await expect(runTool(runFlowTool, { flow: "F" }, AUTH)).rejects.toBeInstanceOf(McpToolError);
    expect(runAiFlowTool).not.toHaveBeenCalled();
  });
});

describe("list_flow_versions / restore_flow_version", () => {
  const VERSION = {
    id: 9,
    flow_id: FLOW_ID,
    business_id: "biz-1",
    definition: { version: 1, trigger: { channel: "manual" }, steps: [{ id: "s1" }] },
    name: "Lead follow-up",
    enabled: true,
    source: "ai_edit_sms",
    actor: "+15555550100",
    replaced_at: "2026-08-18T04:00:00Z"
  };

  it("lists history newest-first with the step count and the surface that changed it", async () => {
    vi.mocked(listFlowVersions).mockResolvedValue([VERSION] as never);
    const res = await runTool(listFlowVersionsTool, { flow_id: FLOW_ID }, AUTH);
    expect(res).toEqual({
      versions: [
        {
          version_id: 9,
          replaced_at: "2026-08-18T04:00:00Z",
          source: "ai_edit_sms",
          actor: "+15555550100",
          name: "Lead follow-up",
          step_count: 1
        }
      ]
    });
  });

  it("restores the most recent version when no version_id is given", async () => {
    vi.mocked(restoreFlowVersion).mockResolvedValue({
      ok: true,
      flowId: FLOW_ID,
      flowName: "Lead follow-up",
      versionId: 9,
      replacedAt: "2026-08-18T04:00:00Z",
      undoneSource: "ai_edit_sms"
    } as never);
    const res = await runTool(restoreFlowVersionTool, { flow_id: FLOW_ID }, AUTH);
    expect(res).toMatchObject({ restored: true, flow_id: FLOW_ID });
    expect(restoreFlowVersion).toHaveBeenCalledWith(
      "biz-1",
      FLOW_ID,
      expect.objectContaining({ editSource: "mcp_restore", editActor: "user-1" })
    );
    // The restore is itself an edit, so it must be attributed too.
    expect(vi.mocked(restoreFlowVersion).mock.calls[0][2]).not.toHaveProperty("versionId");
  });

  it("targets an explicit version_id when given", async () => {
    vi.mocked(restoreFlowVersion).mockResolvedValue({
      ok: true,
      flowId: FLOW_ID,
      flowName: "Lead follow-up",
      versionId: 4,
      replacedAt: "2026-08-17T04:00:00Z",
      undoneSource: null
    } as never);
    await runTool(restoreFlowVersionTool, { flow_id: FLOW_ID, version_id: 4 }, AUTH);
    expect(vi.mocked(restoreFlowVersion).mock.calls[0][2]).toMatchObject({ versionId: 4 });
  });

  it("surfaces a refusal as a tool error rather than a silent no-op", async () => {
    vi.mocked(restoreFlowVersion).mockResolvedValue({
      ok: false,
      message: "This automation has no earlier version recorded, so there is nothing to undo."
    } as never);
    await expect(
      runTool(restoreFlowVersionTool, { flow_id: FLOW_ID }, AUTH)
    ).rejects.toThrow(/nothing to undo/);
  });

  it("both tools require the manage_aiflows role", async () => {
    vi.mocked(requireMcpBusinessRole).mockRejectedValueOnce(new McpToolError("nope"));
    await expect(runTool(listFlowVersionsTool, { flow_id: FLOW_ID }, AUTH)).rejects.toThrow("nope");
    vi.mocked(requireMcpBusinessRole).mockRejectedValueOnce(new McpToolError("nope"));
    await expect(
      runTool(restoreFlowVersionTool, { flow_id: FLOW_ID }, AUTH)
    ).rejects.toThrow("nope");
  });
});
