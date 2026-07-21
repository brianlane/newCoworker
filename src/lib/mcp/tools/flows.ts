/**
 * AiFlow automation tools: full CRUD over the business's flows plus the
 * webhook-event trigger, with the exact validation stack the dashboard
 * builder uses (`parseAiFlowDefinition` + document/agent binding checks) —
 * an invalid definition is refused with the validator's issues instead of
 * being persisted.
 *
 * `get_flow_schema` returns the machine-readable definition schema (JSON
 * Schema derived from the builder's zod source of truth) so Claude can
 * author valid definitions without guessing the vocabulary.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId
} from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";
import { rateLimit } from "@/lib/rate-limit";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe("Business the flows belong to. Optional when the account has exactly one business.");

// Same ceiling as the public flow-events endpoint.
const MCP_FLOW_EVENT_RATE = { interval: 60 * 1000, maxRequests: 120 };
/** Serialized payload ceiling — a lead form is KBs, not MBs. */
const MAX_EVENT_DATA_BYTES = 64 * 1024;

/**
 * Validate a candidate definition exactly like POST/PATCH /api/aiflows:
 * shape via parseAiFlowDefinition (throws AiFlowValidationError), then the
 * document/agent binding checks that shape validation can't know.
 */
export async function validateFlowDefinition(
  businessId: string,
  definition: unknown
): Promise<void> {
  const { AiFlowValidationError, parseAiFlowDefinition } = await import(
    "@/lib/ai-flows/schema"
  );
  let parsed;
  try {
    parsed = parseAiFlowDefinition(definition);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      throw new McpToolError(
        `Invalid flow definition — ${err.message}: ${err.issues.join("; ")}. Call get_flow_schema for the definition format.`
      );
    }
    throw err;
  }
  const { validateShareDocumentSteps } = await import("@/lib/ai-flows/document-steps");
  const { validateRunAgentSteps } = await import("@/lib/ai-flows/agent-steps");
  const documentIssues = await validateShareDocumentSteps(businessId, parsed);
  const agentIssues = await validateRunAgentSteps(businessId, parsed);
  const issues = [...documentIssues, ...agentIssues];
  if (issues.length > 0) {
    throw new McpToolError(`Invalid flow definition: ${issues.join("; ")}`);
  }
}

export const listFlowsTool = defineMcpTool({
  name: "list_flows",
  description:
    "List the business's AiFlows (automations): name, enabled state, trigger channel, and last-run time. Use get_flow for a flow's full definition.",
  schema: { business_id: businessIdField },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    const { listAiFlows } = await import("@/lib/ai-flows/db");
    const rows = await listAiFlows(businessId);
    return {
      flows: rows.map((row) => ({
        flow_id: row.id,
        name: row.name,
        enabled: row.enabled,
        trigger_channel: row.definition.trigger.channel,
        step_count: row.definition.steps.length,
        updated_at: row.updated_at
      }))
    };
  }
});

export const getFlowTool = defineMcpTool({
  name: "get_flow",
  description: "Get one AiFlow's full definition (trigger, steps, settings).",
  schema: {
    business_id: businessIdField,
    flow_id: z.string().uuid()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    const { getAiFlow } = await import("@/lib/ai-flows/db");
    const row = await getAiFlow(businessId, args.flow_id);
    if (!row) throw new McpToolError("Flow not found.");
    return {
      flow_id: row.id,
      name: row.name,
      enabled: row.enabled,
      definition: row.definition,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
});

export const getFlowSchemaTool = defineMcpTool({
  name: "get_flow_schema",
  description:
    "The AiFlow definition format as JSON Schema, plus the step-type and trigger-channel vocabulary. Read this before authoring or editing a flow definition for create_flow / update_flow.",
  schema: {},
  handler: async () => {
    const {
      FLOW_STEP_TYPES,
      TRIGGER_CHANNELS,
      VOICE_STEP_TYPES,
      aiFlowDefinitionSchema
    } = await import("@/lib/ai-flows/schema");
    let jsonSchema: unknown = null;
    try {
      jsonSchema = z.toJSONSchema(aiFlowDefinitionSchema, {
        io: "input",
        unrepresentable: "any"
      });
    } catch {
      // Some zod constructs (transforms/refinements) may not be representable;
      // the vocabulary + validation errors from create_flow still guide authoring.
      jsonSchema = null;
    }
    return {
      step_types: FLOW_STEP_TYPES,
      trigger_channels: TRIGGER_CHANNELS,
      voice_only_step_types: VOICE_STEP_TYPES,
      notes:
        "A definition is { version: 1, trigger, steps: [...] }. Voice-channel triggers may only use the voice-only step types, and vice versa. create_flow/update_flow validate the definition and return precise issues when it is invalid. options.agentInvocable: true lets the TEXTING coworker enroll the customer it is currently texting with into this flow (owner opt-in per flow; default off).",
      json_schema: jsonSchema
    };
  }
});

export const createFlowTool = defineMcpTool({
  name: "create_flow",
  description:
    "Create a new AiFlow automation. The definition is validated (call get_flow_schema for the format); invalid definitions are refused with the exact issues. New flows default to disabled unless enabled is true.",
  schema: {
    business_id: businessIdField,
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().optional(),
    definition: z
      .record(z.string(), z.unknown())
      .describe("The flow definition object — see get_flow_schema.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    await validateFlowDefinition(businessId, args.definition);
    const { createAiFlow } = await import("@/lib/ai-flows/db");
    const row = await createAiFlow({
      businessId,
      name: args.name,
      // Default OFF (createAiFlow's own default is on): a model-authored
      // flow must not go live without an explicit enabled:true opt-in.
      enabled: args.enabled ?? false,
      definition: args.definition,
      createdBy: auth.userId
    });
    return { created: true, flow_id: row.id, name: row.name, enabled: row.enabled };
  }
});

export const updateFlowTool = defineMcpTool({
  name: "update_flow",
  description:
    "Update an AiFlow's name and/or definition. A supplied definition REPLACES the whole definition and is validated like create_flow (fetch the current one with get_flow first).",
  schema: {
    business_id: businessIdField,
    flow_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    definition: z.record(z.string(), z.unknown()).optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    if (args.name === undefined && args.definition === undefined) {
      throw new McpToolError("Nothing to update — pass name and/or definition.");
    }
    if (args.definition !== undefined) {
      await validateFlowDefinition(businessId, args.definition);
    }
    const { updateAiFlow } = await import("@/lib/ai-flows/db");
    const row = await updateAiFlow({
      businessId,
      id: args.flow_id,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.definition !== undefined ? { definition: args.definition } : {})
    });
    return { updated: true, flow_id: row.id, name: row.name, enabled: row.enabled };
  }
});

export const setFlowEnabledTool = defineMcpTool({
  name: "set_flow_enabled",
  description: "Turn one AiFlow on or off.",
  schema: {
    business_id: businessIdField,
    flow_id: z.string().uuid(),
    enabled: z.boolean()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    const { updateAiFlow } = await import("@/lib/ai-flows/db");
    const row = await updateAiFlow({
      businessId,
      id: args.flow_id,
      enabled: args.enabled
    });
    return { flow_id: row.id, enabled: row.enabled };
  }
});

export const triggerFlowTool = defineMcpTool({
  name: "trigger_flow",
  description:
    "Send an event to the business's webhook-triggered AiFlows: every enabled webhook flow whose conditions match the payload gets a queued run (e.g. forward a new lead into the flow engine). Idempotent per event_id.",
  schema: {
    business_id: businessIdField,
    source: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Where the event came from (matched by flows' from conditions); defaults to 'webhook'."),
    event_id: z
      .string()
      .min(1)
      .max(180)
      .optional()
      .describe("Idempotency key — redeliveries with the same id never double-enqueue."),
    data: z
      .record(z.string(), z.unknown())
      .describe("The event payload — lead fields as a flat-ish JSON object.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    if (JSON.stringify(args.data).length > MAX_EVENT_DATA_BYTES) {
      throw new McpToolError("data payload too large (64KB max)");
    }
    const limiter = rateLimit(`mcp-flow-events:${businessId}`, MCP_FLOW_EVENT_RATE);
    if (!limiter.success) {
      throw new McpToolError("Flow-event rate limit exceeded — retry shortly.");
    }
    const { processWebhookFlowEvent } = await import("@/lib/ai-flows/webhook-events");
    const result = await processWebhookFlowEvent(businessId, {
      source: args.source?.trim() || "webhook",
      data: args.data,
      eventId: args.event_id
    });
    return {
      enqueued: result.enqueued,
      flows_evaluated: result.flowsEvaluated,
      flows_matched: result.flowsMatched
    };
  }
});

export const flowTools = [
  listFlowsTool,
  getFlowTool,
  getFlowSchemaTool,
  createFlowTool,
  updateFlowTool,
  setFlowEnabledTool,
  triggerFlowTool
];
