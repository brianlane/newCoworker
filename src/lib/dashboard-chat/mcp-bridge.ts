/**
 * MCP-to-Gemini tool bridge: the connector tool catalog (src/lib/mcp/**),
 * adapted into the inline engine's extraTools seam so the Gemini-powered
 * owner surfaces (dashboard chat + companion, owner-SMS operator, Slack
 * owner turns) can do what Claude and ChatGPT already can.
 *
 * Design rules, each load-bearing:
 *
 * - ONE TOOL PER CAPABILITY PER SURFACE. Tools that duplicate an inline
 *   capability are excluded (with the reason recorded), so a turn never
 *   declares two names for one verb: live flow edits stay `edit_aiflow`
 *   (validated plain-English) rather than raw `update_flow`, creation
 *   stays the draft-first `create_aiflow`, and the send/calendar/roster
 *   tools keep their inline versions with the owner-surface safety copy.
 *   A unit test pins the partition as an exact disjoint cover of
 *   `allMcpTools`, so MCP tool #38 forces an explicit decision here.
 *
 * - BUSINESS SCOPE IS PINNED. The executor overwrites `business_id` with
 *   the surface's active business on every call and refuses `fetch` ids
 *   whose embedded business differs, so a companion turn can never cross
 *   tenants no matter what the model passes. `requireMcpBusinessRole`
 *   still re-checks the caller's role inside every handler (the same
 *   central matrix the connectors use); the bridge only narrows.
 *
 * - NEVER THROWS. Handler refusals (McpToolError) become honest
 *   `{ok:false}` payloads the model can relay; anything else logs and
 *   degrades to a generic failure, mirroring `runMcpTool`.
 */

import { z } from "zod";
import { allMcpTools } from "@/lib/mcp/registry";
import { McpToolError } from "@/lib/mcp/auth";
import { parseMcpResourceId } from "@/lib/mcp/resource-id";
import type { McpToolDef } from "@/lib/mcp/tooling";
import type { GeminiFunctionDeclaration } from "@/lib/gemini-chat";
import type { InlineExtraTools } from "@/lib/dashboard-chat/inline-turn";
import { can, type BusinessAction, type BusinessRole } from "@/lib/authz/policy";
import { logger } from "@/lib/logger";

/** Settings gate GROUPS (Settings → Coworker tools toggles), not per-tool. */
export const MCP_BRIDGE_GATE_KEYS = [
  "read_business_data",
  "manage_contacts",
  "manage_flows",
  "manage_agents",
  "update_business_profile",
  "update_business_knowledge",
  "manage_coworker_tools"
] as const;

export type McpBridgeGateKey = (typeof MCP_BRIDGE_GATE_KEYS)[number];

export type McpBridgeGates = Record<McpBridgeGateKey, boolean>;

/**
 * Bridged tool → its gate group. Grouped rather than per-tool for the same
 * reason `list_aiflows` rides the `run_aiflow` toggle: 23 individual
 * switches would bury the Settings page, and the groups match how owners
 * think ("can it read my data", "can it change automations").
 */
export const MCP_BRIDGE_TOOL_GATES: Readonly<Record<string, McpBridgeGateKey>> = {
  get_business: "read_business_data",
  search_contacts: "read_business_data",
  get_contact: "read_business_data",
  get_sms_thread: "read_business_data",
  list_recent_events: "read_business_data",
  list_call_transcripts: "read_business_data",
  list_tasks: "read_business_data",
  fetch: "read_business_data",
  get_flow: "read_business_data",
  get_flow_schema: "read_business_data",
  list_flow_versions: "read_business_data",
  list_agents: "read_business_data",
  list_employees: "read_business_data",
  get_notification_preferences: "read_business_data",
  create_contact: "manage_contacts",
  update_contact: "manage_contacts",
  set_flow_enabled: "manage_flows",
  trigger_flow: "manage_flows",
  update_agent: "manage_agents",
  delete_agent: "manage_agents",
  update_business_profile: "update_business_profile",
  get_business_knowledge: "update_business_knowledge",
  update_business_knowledge: "update_business_knowledge",
  update_coworker_tool_settings: "manage_coworker_tools"
};

export const MCP_BRIDGE_TOOL_NAMES: readonly string[] = Object.keys(MCP_BRIDGE_TOOL_GATES);

export function isMcpBridgeToolName(name: string): boolean {
  return name in MCP_BRIDGE_TOOL_GATES;
}

/**
 * The role bar each bridged handler enforces internally
 * (requireMcpBusinessRole's `action` argument), mirrored here so the
 * DECLARATION layer can drop tools the caller's role can only get refused
 * on — a staff turn must not burn scarce tool steps on get_flow calls that
 * always fail (Bugbot Medium on PR #1382). The handlers stay the
 * enforcement point; this mirror only prunes declarations, and the bridge
 * test pins every bridged name to an entry so the map cannot drift silently.
 */
export const MCP_BRIDGE_TOOL_ACTIONS: Readonly<Record<string, BusinessAction>> = {
  get_business: "view_dashboard",
  list_recent_events: "view_dashboard",
  list_call_transcripts: "view_dashboard",
  list_tasks: "view_dashboard",
  search_contacts: "operate_messages",
  get_contact: "operate_messages",
  get_sms_thread: "operate_messages",
  fetch: "operate_messages",
  get_flow: "manage_aiflows",
  get_flow_schema: "manage_aiflows",
  list_flow_versions: "manage_aiflows",
  list_agents: "manage_aiflows",
  list_employees: "manage_settings",
  get_notification_preferences: "manage_settings",
  create_contact: "operate_messages",
  update_contact: "operate_messages",
  set_flow_enabled: "manage_aiflows",
  trigger_flow: "manage_aiflows",
  update_agent: "manage_aiflows",
  delete_agent: "manage_aiflows",
  update_business_profile: "manage_settings",
  get_business_knowledge: "manage_settings",
  update_business_knowledge: "manage_settings",
  update_coworker_tool_settings: "manage_settings"
};

/** Handlers that additionally require the literal owner role. */
export const MCP_BRIDGE_OWNER_ONLY: ReadonlySet<string> = new Set([
  "get_business_knowledge",
  "update_business_knowledge"
]);

/**
 * MCP tools deliberately NOT bridged, with the reason. Unit-pinned together
 * with the bridged set as an exact disjoint cover of `allMcpTools`.
 */
export const MCP_BRIDGE_EXCLUDED: Readonly<Record<string, string>> = {
  send_sms: "exact name collision: the inline action tool carries the owner-surface guidance, STOP-list posture, and dashboard_chat send logging",
  send_whatsapp: "exact name collision: the inline action tool is connection-aware and carries the owner-surface guidance",
  calendar_find_slots: "exact name collision with the inline calendar lifecycle",
  calendar_book_appointment: "exact name collision with the inline calendar lifecycle",
  create_agent: "exact name collision: the inline draft tool hands the owner a review card; the MCP tool persists directly",
  update_notification_preferences: "exact name collision: the inline action tool already composes the manage_settings role gate",
  list_flows: "capability duplicate of inline list_aiflows (same core); two list tools is the model-confusion trap",
  run_flow: "capability duplicate of inline run_aiflow (same manual-run core)",
  create_employee: "capability duplicate of inline manage_employee, whose copy carries the read-back-the-number safety",
  update_employee: "capability duplicate of inline manage_employee",
  create_flow: "capability duplicate of the draft-first create_aiflow: chat creation stays owner-reviewed in the builder; connectors keep live create_flow",
  update_flow: "capability duplicate of inline edit_aiflow, which validates and self-repairs instead of replacing raw JSON",
  restore_flow_version: "capability duplicate of inline undo_aiflow_edit, which resolves the flow by name the way the owner refers to it",
  list_businesses: "the surface is pinned to one business; a cross-business enumerator invites scope-hopping",
  search: "cross-business fan-out; with a pinned business it degenerates to search_contacts + get_sms_thread"
};

/**
 * ok:true results from these names COMMITTED something (row written, run
 * enqueued, policy changed): the turn must pin so the worker fallback never
 * re-runs the owner's message (same contract as SIDE_EFFECT_TOOLS).
 * `create_contact`/`update_contact` count because contact events enqueue
 * automations that can text the person; `trigger_flow` enqueues runs now.
 */
export const MCP_BRIDGE_SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "create_contact",
  "update_contact",
  "set_flow_enabled",
  "trigger_flow",
  "update_agent",
  "delete_agent",
  "update_business_profile",
  "update_business_knowledge",
  "update_coworker_tool_settings"
]);

/** Owner-facing fact line for a committed bridged effect (degraded wrap-up). */
export function mcpBridgeSideEffectNote(name: string, result: unknown): string {
  const data = (result as { data?: Record<string, unknown> } | null)?.data ?? {};
  if (name === "create_contact") return "The contact was created (its automations may message them).";
  if (name === "update_contact") return "The contact was updated.";
  if (name === "set_flow_enabled") {
    const enabled = (data as { enabled?: unknown }).enabled;
    return typeof enabled === "boolean"
      ? `The automation was turned ${enabled ? "ON" : "OFF"}.`
      : "The automation's enabled state was changed.";
  }
  if (name === "trigger_flow") return "The automation run was started; it can be watched at /dashboard/aiflows.";
  if (name === "update_agent") return "The agent was updated.";
  if (name === "delete_agent") return "The agent was deleted.";
  if (name === "update_business_profile") return "The business hours/timezone were updated.";
  if (name === "update_business_knowledge") return "The coworker's knowledge section was updated.";
  if (name === "update_coworker_tool_settings") return "The coworker tool policy was changed for the listed channels.";
  return `The ${name} action went through.`;
}

/**
 * Bridge-specific description overrides. Only where the connector wording
 * points at a tool this surface does not declare.
 */
const BRIDGE_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  fetch:
    "Open one record by the id another tool returned: a call transcript id from list_call_transcripts, or a contact/conversation id from search_contacts results. Returns the full record."
};

/**
 * System block appended whenever bridge tools are declared: the one-obvious-
 * path ladder for overlapping capabilities, plus the human-only boundary
 * (the one-shot classes that stay with Settings/support). A function
 * because the automations line must only advertise `create_aiflow` on
 * surfaces that actually declare the creation tools — owner-SMS and Slack
 * pass includeCreationTools: false, and a preamble naming a missing tool
 * invites calls to nothing (Bugbot Medium on PR #1382).
 */
export function mcpBridgeToolsPreamble(opts: { creationToolsDeclared: boolean }): string {
  const creationArm = opts.creationToolsDeclared
    ? " create_aiflow drafts a new one for the owner to activate in the builder;"
    : " there is NO creation tool on this surface, to build a new automation point the owner at dashboard chat or the AiFlows builder;";
  return `DIRECT BUSINESS TOOLS: you can read and change this business's real data (contacts, text conversations, call transcripts, recent activity, tasks, automations, roster, hours, knowledge, per-channel tool policies). Ground answers in tool reads; when a read tool can answer, call it instead of guessing.
- Automations, one path each: list_aiflows finds one; get_flow inspects its steps; edit_aiflow applies a plain-English change to a live automation (validated; prefer it for ANY edit); undo_aiflow_edit puts the version before the last edit back, and list_flow_versions says what changed, when, and from which surface;${creationArm} set_flow_enabled turns one on or off; run_aiflow starts one for a contact.
- Look the contact up with search_contacts BEFORE texting or calling anyone by name. Never invent or guess a phone number or email.
- Knowledge edits: get_business_knowledge first, then update_business_knowledge targeting ONE section.
- OUT OF SCOPE, never attempt with any tool; direct the owner to Settings or support instead: changing any phone number (business line, owner phone), plan or billing changes, buying/porting numbers, connecting or disconnecting integrations, bulk deletions, refunds.`;
}

/**
 * Who is running this turn. `adminViewAsBusinessId` is set only for the
 * platform admin under view-as, and only to the business their cookie pins:
 * it reaches `requireMcpBusinessRole` inside each handler so the operator's
 * bridged tools actually work instead of refusing (see McpAuthUser).
 */
export type McpBridgeCaller = {
  userId: string;
  email: string;
  adminViewAsBusinessId?: string;
};

export type McpBridgeDeps = {
  /** Injectable tool defs (tests). */
  tools?: McpToolDef[];
};

function bridgedDefs(deps: McpBridgeDeps = {}): McpToolDef[] {
  const source = deps.tools ?? allMcpTools;
  return source.filter((t) => isMcpBridgeToolName(t.name));
}

/**
 * Convert one JSON-Schema node (zod v4 `z.toJSONSchema` output) into the
 * Gemini schema subset: keep type/description/enum/properties/required/
 * items, fold `const` into a one-value enum, and flatten a `[null, X]`
 * union into X + nullable. Everything else (formats, bounds, $schema,
 * additionalProperties) is dropped: those are VALIDATION concerns, and the
 * handler's own zod parse remains the enforcement point.
 *
 * Exported for its own tests: the non-object guard is unreachable through
 * zod-generated schemas but must hold if a hand-written def ever feeds it.
 */
export function sanitizeSchemaNode(node: unknown): Record<string, unknown> {
  if (typeof node !== "object" || node === null) return {};
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (Array.isArray(src.anyOf)) {
    const arms = (src.anyOf as unknown[]).map((a) => a as Record<string, unknown>);
    const nonNull = arms.filter((a) => a.type !== "null");
    const hadNull = nonNull.length !== arms.length;
    if (nonNull.length === 1) {
      const flattened = sanitizeSchemaNode(nonNull[0]);
      if (hadNull) flattened.nullable = true;
      if (typeof src.description === "string") flattened.description ??= src.description;
      return flattened;
    }
    out.anyOf = nonNull.map((a) => sanitizeSchemaNode(a));
    if (hadNull) out.nullable = true;
  }

  if (typeof src.type === "string") out.type = src.type;
  if (typeof src.description === "string") out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum;
  else if (src.const !== undefined) out.enum = [src.const];
  if (src.items !== undefined) out.items = sanitizeSchemaNode(src.items);
  if (typeof src.properties === "object" && src.properties !== null) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src.properties as Record<string, unknown>)) {
      props[key] = sanitizeSchemaNode(value);
    }
    out.properties = props;
  }
  if (Array.isArray(src.required) && src.required.length > 0) {
    out.required = (src.required as unknown[]).filter((r) => typeof r === "string");
  }
  return out;
}

/** One tool def → a Gemini declaration, with `business_id` stripped (pinned). */
function toGeminiDeclaration(def: McpToolDef): GeminiFunctionDeclaration {
  const json = z.toJSONSchema(z.object(def.schema), {
    io: "input",
    unrepresentable: "any"
  }) as Record<string, unknown>;
  const sanitized = sanitizeSchemaNode(json);
  // zod always emits `properties` for object schemas (even empty ones),
  // and spreading undefined is a no-op anyway, so no fallback branch.
  const properties = { ...(sanitized.properties as Record<string, unknown>) };
  delete properties.business_id;
  const required = ((sanitized.required as string[]) ?? []).filter(
    (key) => key !== "business_id" && key in properties
  );
  return {
    name: def.name,
    description: BRIDGE_DESCRIPTION_OVERRIDES[def.name] ?? def.description,
    parameters: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {})
    }
  };
}

/**
 * Declarations for every bridged tool whose Settings gate is ON and whose
 * handler bar the caller's role can actually pass, stable order. The role
 * pruning mirrors the handlers (MCP_BRIDGE_TOOL_ACTIONS); a null role
 * declares nothing.
 */
export function mcpBridgeDeclarations(
  gates: McpBridgeGates,
  role: BusinessRole | null,
  deps: McpBridgeDeps = {}
): GeminiFunctionDeclaration[] {
  if (role == null) return [];
  return bridgedDefs(deps)
    .filter(
      (def) =>
        gates[MCP_BRIDGE_TOOL_GATES[def.name]] &&
        can(role, MCP_BRIDGE_TOOL_ACTIONS[def.name]) &&
        (!MCP_BRIDGE_OWNER_ONLY.has(def.name) || role === "owner")
    )
    .map((def) => toGeminiDeclaration(def));
}

/**
 * Execute one bridged call as the verified caller, pinned to `businessId`.
 * Never throws; the payload shapes mirror the inline action tools.
 */
export async function executeMcpBridgeTool(
  businessId: string,
  caller: McpBridgeCaller,
  call: { name: string; args: Record<string, unknown> },
  deps: McpBridgeDeps = {}
): Promise<unknown> {
  const def = bridgedDefs(deps).find((t) => t.name === call.name);
  if (!def) {
    return { ok: false, message: `unknown tool: ${call.name}` };
  }
  // Pin the scope: the surface's business wins over anything model-supplied.
  const raw: Record<string, unknown> = { ...call.args, business_id: businessId };
  // The connector path's SDK validates inputSchema before the handler runs;
  // handlers do NOT re-parse. Mirror that here or missing/mistyped fields
  // skip every length/email/uuid/union check (Bugbot Medium on PR #1382).
  const parsedArgs = z.object(def.schema).safeParse(raw);
  if (!parsedArgs.success) {
    // A failed safeParse always carries at least one issue, and z.object
    // shape errors are always field-addressed, so no defensive arms here.
    const first = parsedArgs.error.issues[0];
    return {
      ok: false,
      message: `Invalid ${call.name} arguments: ${first.path.join(".")} ${first.message}.`
    };
  }
  const args = parsedArgs.data as Record<string, unknown>;
  try {
    if (call.name === "fetch") {
      // The embedded business must match the pin. Same single generic
      // refusal as the parser's own, so a cross-tenant probe learns
      // nothing from the wording.
      const rawId = typeof args.id === "string" ? args.id : "";
      const parsed = parseMcpResourceId(rawId);
      if (parsed.businessId !== businessId) {
        return {
          ok: false,
          message:
            "That id is not one this connector issued. Call search first and pass an id from its results."
        };
      }
    }
    const data = await def.handler(args, {
      userId: caller.userId,
      email: caller.email,
      adminViewAsBusinessId: caller.adminViewAsBusinessId
    });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof McpToolError) {
      return { ok: false, message: err.message };
    }
    logger.warn("mcp bridge tool failed", {
      businessId,
      tool: call.name,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, message: `The ${call.name} tool hit an internal error, try again shortly.` };
  }
}

/**
 * Assemble the inline engine's extraTools bundle for one turn. Returns null
 * when every gate is off (nothing to declare), so callers can pass the
 * result straight through.
 */
export function buildMcpBridgeExtraTools(
  businessId: string,
  caller: McpBridgeCaller,
  gates: McpBridgeGates,
  role: BusinessRole | null,
  deps: McpBridgeDeps = {}
): InlineExtraTools | null {
  const declarations = mcpBridgeDeclarations(gates, role, deps);
  if (declarations.length === 0) return null;
  return {
    declarations,
    execute: (call) => executeMcpBridgeTool(businessId, caller, call, deps),
    sideEffectNames: MCP_BRIDGE_SIDE_EFFECT_TOOLS,
    noteFor: mcpBridgeSideEffectNote
  };
}
