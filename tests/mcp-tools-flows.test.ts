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
vi.mock("@/lib/ai-flows/db", () => ({
  listAiFlows: vi.fn(),
  getAiFlow: vi.fn(),
  createAiFlow: vi.fn(),
  updateAiFlow: vi.fn()
}));
vi.mock("@/lib/ai-flows/webhook-events", () => ({ processWebhookFlowEvent: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));

import { McpToolError, requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  createFlowTool,
  getFlowSchemaTool,
  getFlowTool,
  listFlowsTool,
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
import { createAiFlow, getAiFlow, listAiFlows, updateAiFlow } from "@/lib/ai-flows/db";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { rateLimit } from "@/lib/rate-limit";

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
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 1, remaining: 1, reset: 0 });
});

describe("validateFlowDefinition", () => {
  it("passes a valid definition through both validation layers", async () => {
    await expect(validateFlowDefinition("biz-1", DEFINITION)).resolves.toBeUndefined();
    expect(validateShareDocumentSteps).toHaveBeenCalledWith("biz-1", DEFINITION);
    expect(validateRunAgentSteps).toHaveBeenCalledWith("biz-1", DEFINITION);
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

  it("refuses definitions with document/agent binding issues", async () => {
    vi.mocked(validateShareDocumentSteps).mockResolvedValue(["doc missing"]);
    vi.mocked(validateRunAgentSteps).mockResolvedValue(["agent disabled"]);
    await expect(validateFlowDefinition("biz-1", DEFINITION)).rejects.toThrow(
      /doc missing; agent disabled/
    );
  });
});

describe("list_flows / get_flow", () => {
  it("lists flows with trigger channel and step count", async () => {
    vi.mocked(listAiFlows).mockResolvedValue([FLOW_ROW as never]);
    const result = (await listFlowsTool.handler({}, AUTH)) as { flows: unknown[] };
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
    const result = (await getFlowTool.handler({ flow_id: FLOW_ID }, AUTH)) as {
      definition: unknown;
    };
    expect(result.definition).toEqual(DEFINITION);
  });

  it("errors on an unknown flow", async () => {
    vi.mocked(getAiFlow).mockResolvedValue(null);
    await expect(getFlowTool.handler({ flow_id: FLOW_ID }, AUTH)).rejects.toThrow(
      /Flow not found/
    );
  });
});

describe("get_flow_schema", () => {
  it("returns the vocabulary plus the derived JSON Schema", async () => {
    schemaHolder.override = z.object({ version: z.literal(1) });
    try {
      const result = (await getFlowSchemaTool.handler({}, AUTH)) as {
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
      const result = (await getFlowSchemaTool.handler({}, AUTH)) as {
        json_schema: unknown;
      };
      expect(result.json_schema).toBeNull();
    } finally {
      schemaHolder.override = null;
    }
  });
});

describe("create_flow / update_flow / set_flow_enabled", () => {
  it("creates a validated flow attributed to the caller", async () => {
    vi.mocked(createAiFlow).mockResolvedValue({ ...FLOW_ROW, enabled: false } as never);
    const result = await createFlowTool.handler(
      { name: "Lead intake", definition: DEFINITION },
      AUTH
    );
    expect(createAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      name: "Lead intake",
      enabled: undefined,
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

  it("refuses an update with nothing to change", async () => {
    await expect(updateFlowTool.handler({ flow_id: FLOW_ID }, AUTH)).rejects.toThrow(
      /Nothing to update/
    );
    expect(updateAiFlow).not.toHaveBeenCalled();
  });

  it("renames without re-validating a definition", async () => {
    vi.mocked(updateAiFlow).mockResolvedValue(FLOW_ROW as never);
    await updateFlowTool.handler({ flow_id: FLOW_ID, name: "Renamed" }, AUTH);
    expect(parseAiFlowDefinition).not.toHaveBeenCalled();
    expect(updateAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      id: FLOW_ID,
      name: "Renamed"
    });
  });

  it("validates a replacement definition before persisting", async () => {
    vi.mocked(updateAiFlow).mockResolvedValue(FLOW_ROW as never);
    const result = await updateFlowTool.handler(
      { flow_id: FLOW_ID, definition: DEFINITION },
      AUTH
    );
    expect(parseAiFlowDefinition).toHaveBeenCalledWith(DEFINITION);
    expect(updateAiFlow).toHaveBeenCalledWith({
      businessId: "biz-1",
      id: FLOW_ID,
      definition: DEFINITION
    });
    expect(result).toMatchObject({ updated: true, flow_id: FLOW_ID });
  });

  it("toggles enabled", async () => {
    vi.mocked(updateAiFlow).mockResolvedValue({ ...FLOW_ROW, enabled: false } as never);
    const result = await setFlowEnabledTool.handler(
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
    const result = await triggerFlowTool.handler(
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
    await triggerFlowTool.handler({ data: {} }, AUTH);
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ source: "webhook" })
    );
  });

  it("refuses oversized payloads before rate limiting", async () => {
    const big = { blob: "x".repeat(65 * 1024) };
    await expect(triggerFlowTool.handler({ data: big }, AUTH)).rejects.toThrow(/64KB max/);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("refuses when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 1, remaining: 0, reset: 0 });
    await expect(triggerFlowTool.handler({ data: {} }, AUTH)).rejects.toBeInstanceOf(
      McpToolError
    );
    expect(processWebhookFlowEvent).not.toHaveBeenCalled();
  });
});
