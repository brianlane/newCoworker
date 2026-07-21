/**
 * Claude-connector notification tools (KYP, Jul 20 2026: "let me know when
 * clients text back" had no tool behind it).
 *
 * Both tools are manage_settings-gated — the SAME permission matrix as the
 * dashboard notifications page (manager+), so a staff-role connector user
 * can neither read nor mutate alert settings. Mutation goes through the
 * shared whitelist core: boolean toggles only, never `phone_number`,
 * `alert_email`, digest recipients, or `unsubscribed_at`. The read answers
 * the toggle map plus recipient PRESENCE (configured yes/no) — never the
 * recipients themselves, since the model has no need for that PII to answer
 * "is it on?".
 */

import { z } from "zod";
import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";
import {
  applyNotificationPreferenceToggles,
  NOTIFICATION_TOGGLE_KEYS,
  notificationToggleMap
} from "@/lib/notifications/preferences-tool";
import {
  defaultNotificationPreferencesRow,
  getNotificationPreferences
} from "@/lib/db/notification-preferences";

const TOGGLE_SCHEMA = Object.fromEntries(
  NOTIFICATION_TOGGLE_KEYS.map((key) => [
    key,
    z
      .boolean()
      .optional()
      .describe(`Set the ${key.replace(/_/g, " ")} toggle.`)
  ])
) as Record<string, z.ZodOptional<z.ZodBoolean>>;

export const updateNotificationPreferencesTool = defineMcpTool({
  name: "update_notification_preferences",
  description:
    "Turn the business's notification/alert toggles on or off (e.g. customer_reply_alerts to text the owner the moment a client texts the business). Managers and owners only. Booleans only — the alert phone number and email cannot be changed here (dashboard Settings → Notifications). Pass only the toggles the user asked to change.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to update. Optional when the account has exactly one business."),
    ...TOGGLE_SCHEMA
  },
  handler: async (args, auth) => {
    const { business_id, ...toggles } = args as Record<string, unknown>;
    const businessId = await resolveMcpBusinessId(auth, business_id as string | undefined);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");

    const result = await applyNotificationPreferenceToggles(businessId, toggles);
    if (!result.ok) {
      throw new McpToolError((result.message ?? result.detail).slice(0, 300));
    }
    return { updated: result.data.updated, settings: result.data.settings };
  }
});

export const getNotificationPreferencesTool = defineMcpTool({
  name: "get_notification_preferences",
  description:
    "Read the business's notification/alert toggle settings (which alerts are on or off, and whether an alert phone/email is configured). Managers and owners only.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to read. Optional when the account has exactly one business.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_settings");

    // Read-only: a business that never opened the notifications page answers
    // the registry defaults instead of creating a row as a side effect.
    const row =
      (await getNotificationPreferences(businessId)) ??
      defaultNotificationPreferencesRow(businessId);
    return {
      settings: notificationToggleMap(row),
      alert_phone_configured: Boolean(row.phone_number?.trim()),
      alert_email_configured: Boolean(row.alert_email?.trim()),
      unsubscribed: Boolean(row.unsubscribed_at)
    };
  }
});

export const notificationTools = [
  updateNotificationPreferencesTool,
  getNotificationPreferencesTool
];
