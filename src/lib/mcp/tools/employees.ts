/**
 * Employee roster tools: read the team, add someone, and change who receives
 * leads and how.
 *
 * Writes go through the shared `manageEmployee` core, the same one the
 * dashboard chat and owner-SMS surfaces use and the same db helpers the
 * Employees page writes through, so a roster edit from Claude behaves
 * identically to one made in the UI.
 *
 * Role bar is `manage_settings`, because the roster decides who receives
 * leads: it matches the Employees page rather than the looser
 * `operate_messages` the contact tools use.
 */

import { z } from "zod";
import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import { manageEmployee, type ManageEmployeeResult } from "@/lib/employees/manage-tool";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe("Business the roster belongs to. Optional when the account has exactly one business.");

const availabilityFields = {
  lead_rotation: z
    .boolean()
    .optional()
    .describe(
      "Receive leads in the round-robin rotation, including automatic assignment. Does not cover automations that ask for them by name (see named_leads)."
    ),
  named_leads: z
    .boolean()
    .optional()
    .describe(
      'Receive one lead when an automation asks for them specifically ("I want Amy on this one"). Independent of lead_rotation.'
    ),
  named_group_offers: z
    .boolean()
    .optional()
    .describe(
      'Be included when an automation texts one lead to several named people at once and the first to reply "1" takes it.'
    ),
  whole_team_offers: z
    .boolean()
    .optional()
    .describe(
      "Be included when something is offered to the entire team at once, such as the team-first human handoff."
    )
};

/** The core reports failures in its payload; MCP wants them thrown. */
function unwrap(result: ManageEmployeeResult): Extract<ManageEmployeeResult, { ok: true }> {
  if (!result.ok) throw new McpToolError(result.message);
  return result;
}

/**
 * snake_case tool args to the core's camelCase, omitting anything the caller
 * left out so column defaults (create) and stored values (update) survive.
 * One mapper for both writers: a hand-copied list is how a new flag ships
 * wired on one path and silently missing on the other.
 */
function availabilityArgs(args: {
  lead_rotation?: boolean;
  named_leads?: boolean;
  named_group_offers?: boolean;
  whole_team_offers?: boolean;
}) {
  return {
    ...(args.lead_rotation !== undefined ? { leadRotation: args.lead_rotation } : {}),
    ...(args.named_leads !== undefined ? { namedLeads: args.named_leads } : {}),
    ...(args.named_group_offers !== undefined
      ? { namedGroupOffers: args.named_group_offers }
      : {}),
    ...(args.whole_team_offers !== undefined ? { wholeTeamOffers: args.whole_team_offers } : {})
  };
}

/**
 * The roster row as `manageEmployee` reports it back. Loose because the shape
 * is owned by src/lib/employees/manage-tool.ts, and a field added there must
 * not turn every roster write into an error result here.
 */
const EMPLOYEE_SHAPE = z.looseObject({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string(),
  email: z.string().nullable(),
  active: z.boolean(),
  leadRotation: z.boolean(),
  namedLeads: z.boolean(),
  namedGroupOffers: z.boolean(),
  wholeTeamOffers: z.boolean()
});

export const listEmployeesTool = defineMcpTool({
  name: "list_employees",
  title: "List the team roster",
  annotations: TOOL_BEHAVIOR.readLocal,
  outputSchema: z.object({
    employees: z.array(
      z.looseObject({
        name: z.string(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        active: z.boolean(),
        weekly_schedule: z.string().nullable(),
        preferred_times: z.string().nullable(),
        lead_rotation: z.boolean(),
        named_leads: z.boolean(),
        named_group_offers: z.boolean(),
        whole_team_offers: z.boolean()
      })
    )
  }),
  description:
    "List the business's employee roster: names, numbers, whether each is active, their working hours, and how each one receives leads (rotation, named group offers, whole-team offers).",
  schema: { business_id: businessIdField },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const [{ listTeamMembers }, { formatScheduleText }] = await Promise.all([
      import("@/lib/db/employees"),
      import("@/lib/employees/schedule-text")
    ]);
    const members = await listTeamMembers(businessId);
    return {
      employees: members.map((m) => ({
        name: m.name,
        phone: m.phone_e164,
        email: m.email,
        active: m.active,
        weekly_schedule: formatScheduleText(m.weekly_schedule) || null,
        preferred_times: formatScheduleText(m.preferred_windows) || null,
        // Pre-migration rows read null over PostgREST; the default is true.
        lead_rotation: m.routing_enabled !== false,
        named_leads: m.named_routing_enabled !== false,
        named_group_offers: m.named_broadcast_enabled !== false,
        whole_team_offers: m.team_broadcast_enabled !== false
      }))
    };
  }
});

export const createEmployeeTool = defineMcpTool({
  name: "create_employee",
  title: "Add a team member",
  annotations: TOOL_BEHAVIOR.writeLocal,
  outputSchema: z.object({
    created: z.boolean(),
    employee: EMPLOYEE_SHAPE,
    note: z.string().optional()
  }),
  description:
    "Add someone to the employee roster so lead-routing automations can offer them leads. Read the number back to the owner after adding: a wrong digit sends their leads to a stranger.",
  schema: {
    business_id: businessIdField,
    name: z.string().trim().min(1).max(120).describe("Their name, as automations should address them."),
    phone: z.string().describe("Their mobile number (any common format)."),
    email: z.string().trim().email().max(254).optional(),
    weekly_schedule: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Working hours, e.g. "mon-fri 09:00-17:00; sat 10:00-14:00". Outside these hours they are not offered leads. Omit for always available.'
      ),
    preferred_times: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Preferred lead hours, same format. Soft priority only: it moves them to the front of the rotation, never excludes them."
      ),
    ...availabilityFields
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const result = unwrap(
      await manageEmployee(businessId, {
        action: "add",
        name: args.name,
        phone: args.phone,
        ...(args.email !== undefined ? { email: args.email } : {}),
        ...(args.weekly_schedule !== undefined ? { scheduleText: args.weekly_schedule } : {}),
        ...(args.preferred_times !== undefined ? { preferredText: args.preferred_times } : {}),
        ...availabilityArgs(args)
      })
    );
    return { created: true, employee: result.employee, note: result.note };
  }
});

export const updateEmployeeTool = defineMcpTool({
  name: "update_employee",
  title: "Update a team member",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: z.object({
    updated: z.boolean(),
    employee: EMPLOYEE_SHAPE,
    note: z.string().optional()
  }),
  description:
    "Change an existing roster member: their name, number, email, working hours, whether they are active, and how they receive leads. Deactivating someone or turning off lead rotation immediately redirects live leads to other people, so confirm with the owner first.",
  schema: {
    business_id: businessIdField,
    employee: z
      .string()
      .min(1)
      .max(160)
      .describe("Who to change: their roster name or their phone number."),
    name: z.string().trim().min(1).max(120).optional().describe("Corrected name."),
    phone: z.string().max(32).optional().describe("Corrected mobile number."),
    email: z.string().trim().max(254).optional().describe("Empty string clears the address."),
    active: z
      .boolean()
      .optional()
      .describe("False deactivates them (no lead offers at all, history kept); true reactivates."),
    weekly_schedule: z
      .string()
      .max(500)
      .optional()
      .describe('Working hours, e.g. "mon-fri 09:00-17:00". Empty string clears the schedule.'),
    preferred_times: z.string().max(500).optional().describe("Preferred lead hours, same format."),
    ...availabilityFields
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    // active=false/true is its own action in the core (it also carries the
    // right note); everything else is a plain update. A call that flips
    // active AND edits fields applies the edits in the same write.
    const action =
      args.active === false ? "deactivate" : args.active === true ? "reactivate" : "update";
    const result = unwrap(
      await manageEmployee(businessId, {
        action,
        employee: args.employee,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.phone !== undefined ? { phone: args.phone } : {}),
        ...(args.email !== undefined ? { email: args.email } : {}),
        ...(args.weekly_schedule !== undefined ? { scheduleText: args.weekly_schedule } : {}),
        ...(args.preferred_times !== undefined ? { preferredText: args.preferred_times } : {}),
        ...availabilityArgs(args)
      })
    );
    return { updated: true, employee: result.employee, note: result.note };
  }
});

export const employeeTools = [listEmployeesTool, createEmployeeTool, updateEmployeeTool];
