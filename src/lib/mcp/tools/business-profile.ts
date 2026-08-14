/**
 * Business profile tool: hours and timezone, through the same shared core
 * the Settings pages use (merge-over-stored days, Intl-validated timezone,
 * profile_md refresh + vault sync), so a change made from Claude, ChatGPT,
 * or the dashboard companion behaves identically to one made in Settings.
 *
 * Deliberately narrow: phone numbers are NOT editable here. Owner-phone
 * changes carry deliverability blast radius (an undeliverable country
 * silently cuts off every owner alert), so they stay in Settings behind
 * their own guards, and the description tells the model to say so.
 */

import { z } from "zod";
import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import { applyBusinessProfileUpdate } from "@/lib/business-profile/update-core";
import { isValidHoursTime } from "@/lib/business-profile/profile";

const timeSchema = z
  .string()
  .refine(isValidHoursTime, "Times must be 24h HH:MM (e.g. 09:00)")
  .describe("24h HH:MM, e.g. 09:00");

const daySchema = z
  .union([z.null(), z.object({ open: timeSchema, close: timeSchema })])
  .optional()
  .describe("Omit to leave the day unchanged; null marks the day closed.");

// Keys are the seven day slugs by construction (BusinessHours is a Partial
// record); string-keyed here because a zod-4 enum-keyed record demands every
// key be present, and a partial schedule is the normal case.
const HOURS_SHAPE = z.record(
  z.string(),
  z.union([z.null(), z.object({ open: z.string(), close: z.string() })])
);

export const updateBusinessProfileTool = defineMcpTool({
  name: "update_business_profile",
  title: "Update business hours or timezone",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: z.object({
    updated: z.boolean(),
    business_hours: HOURS_SHAPE.nullable(),
    timezone: z.string().nullable()
  }),
  description:
    "Update the business's weekly hours and/or its IANA timezone. Days you omit stay unchanged; pass null for a day to mark it closed. The live coworker picks the change up right away (prompt grounding refresh + vault sync). This tool can NOT change the business phone number or the owner's phone number; if asked to change a phone number, do not call this tool, direct the owner to Settings or support instead.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to update. Optional when the account has exactly one business."),
    hours: z
      .object({
        mon: daySchema,
        tue: daySchema,
        wed: daySchema,
        thu: daySchema,
        fri: daySchema,
        sat: daySchema,
        sun: daySchema
      })
      .optional()
      .describe("Per-day windows to change, merged over the saved schedule."),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe('IANA timezone name, e.g. "America/Toronto".')
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");
    const result = await applyBusinessProfileUpdate(businessId, {
      ...(args.hours !== undefined ? { hours: args.hours } : {}),
      ...(args.timezone !== undefined ? { timezone: args.timezone } : {})
    });
    if (!result.ok) throw new McpToolError(result.message);
    return {
      updated: true,
      business_hours: result.business_hours,
      timezone: result.timezone
    };
  }
});

export const businessProfileTools = [updateBusinessProfileTool];
