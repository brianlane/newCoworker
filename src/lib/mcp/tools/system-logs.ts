/**
 * `list_system_logs`: the admin System Logs / "System Errors: All Clients"
 * feed, reachable from the HQ connector.
 *
 * Not bounce-only. Outbound Prospecting (and anyone else) narrows to
 * `email_delivery_failed` with the `event` or `search` filter. The query
 * rides `listSystemLogsAll` / `buildLogSearchFilter` so the LIKE
 * escape stays the one the admin log search already uses.
 *
 * Authz: the HQ owner seat (owner of HQ_BUSINESS_ID) may read fleet-wide
 * when `business_id` is omitted, or any one tenant when it is passed. Every
 * other connector caller is tenant-scoped through the same
 * `resolveMcpBusinessId` + `view_dashboard` path the other read tools use, and
 * cannot see another business's rows. MCP has no admin bypass
 * (`toAuthUser` sets `isAdmin: false`).
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId,
  type McpAuthUser
} from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import {
  LIST_SYSTEM_LOGS_ALL_MAX,
  emailAndDomainFromSystemLog,
  listSystemLogsAll,
  type SystemLogLevel,
  type SystemLogWithBusiness
} from "@/lib/db/system-logs";
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const LIST_DEFAULT = 50;

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Limit to one business. HQ owner may omit this to read fleet-wide (the admin System Errors: All Clients feed) or pass any tenant id. Other seats: optional when the account has exactly one business; otherwise call list_businesses first. Never returns another tenant's rows unless the caller is the HQ owner."
  );

const isoTimestampField = (label: string) =>
  z
    .string()
    .max(40)
    .optional()
    .describe(label);

const logRowShape = z.object({
  id: z.number(),
  created_at: z.string(),
  level: z.string(),
  event: z.string(),
  message: z.string(),
  source: z.string(),
  business_id: z.string().nullable(),
  business_name: z.string().nullable(),
  email: z.string().nullable(),
  domain: z.string().nullable(),
  payload: z.record(z.string(), z.unknown())
});

function requireIsoTimestamp(raw: string | undefined, label: string): string | undefined {
  if (!raw) return undefined;
  if (Number.isNaN(Date.parse(raw))) {
    throw new McpToolError(`${label} must be an ISO timestamp.`);
  }
  return raw;
}

async function callerIsHqOwner(auth: McpAuthUser): Promise<boolean> {
  const { getBusinessRoleForEmail } = await import("@/lib/db/business-members");
  const role = await getBusinessRoleForEmail(HQ_BUSINESS_ID, auth.email);
  return role === "owner";
}

function toLogRow(row: SystemLogWithBusiness): z.infer<typeof logRowShape> {
  const { email, domain } = emailAndDomainFromSystemLog(row);
  return {
    id: row.id,
    created_at: row.created_at,
    level: row.level,
    event: row.event,
    message: row.message,
    source: row.source,
    business_id: row.business_id,
    business_name: row.businesses?.name ?? null,
    email,
    domain,
    payload: row.payload ?? {}
  };
}

export const listSystemLogsTool = defineMcpTool({
  name: "list_system_logs",
  title: "List system logs",
  annotations: TOOL_BEHAVIOR.readLocal,
  outputSchema: z.object({
    scope: z.enum(["fleet", "business"]),
    logs: z.array(logRowShape),
    next_before: z.string().nullable()
  }),
  description:
    "List operational system logs (the same rows as the admin System Logs viewer and the System Errors: All Clients feed), newest first. Not bounce-only: pass event (substring on the event name, for example email_delivery_failed) or search (escaped LIKE across event and message, the same filter the admin log search uses) to narrow. Optional level or minLevel (debug/info/warn/error), source, since (ISO), before (keyset pagination), and limit. HQ owner of the platform HQ tenant may omit business_id for fleet-wide rows including other tenants and platform (null business_id) rows; any other seat only sees a business they can access. Returns email and domain when the payload or message carries them.",
  schema: {
    business_id: businessIdField,
    event: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Substring on the event name (LIKE, underscores matched literally). email_delivery_failed also matches email_delivery_failed_unattributed. For a match anywhere in event or message, use search instead."
      ),
    search: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Substring match against event and message, using the same escaped LIKE as the admin log search. Paste a snake_case event name here when you want it found in either column."
      ),
    level: z
      .enum(LOG_LEVELS)
      .optional()
      .describe("Exact level. When set, minLevel is ignored."),
    minLevel: z
      .enum(LOG_LEVELS)
      .optional()
      .describe(
        "This level and everything more severe (warn returns warn+error). Omit for all levels. The admin System Errors card is minLevel=error."
      ),
    source: z
      .string()
      .max(80)
      .optional()
      .describe("Exact source column (for example email, aiflow, cron)."),
    since: isoTimestampField("Only rows at or after this ISO timestamp."),
    before: isoTimestampField(
      "Only rows strictly older than this ISO timestamp. Pass the previous page's next_before to page."
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_SYSTEM_LOGS_ALL_MAX)
      .optional()
      .describe(`How many to return, newest first. Default ${LIST_DEFAULT}, max ${LIST_SYSTEM_LOGS_ALL_MAX}.`)
  },
  handler: async (args, auth) => {
    const since = requireIsoTimestamp(args.since, "since");
    const before = requireIsoTimestamp(args.before, "before");
    const filters = {
      event: args.event,
      search: args.search,
      level: args.level as SystemLogLevel | undefined,
      minLevel: args.minLevel as SystemLogLevel | undefined,
      source: args.source,
      since,
      before,
      limit: args.limit ?? LIST_DEFAULT
    };

    const hqOwner = await callerIsHqOwner(auth);
    let businessId: string | undefined;
    let scope: "fleet" | "business";
    if (hqOwner) {
      // Stamp the HQ connector; the caller is acting as the HQ seat even
      // when they filter to another tenant.
      await requireMcpBusinessRole(auth, HQ_BUSINESS_ID, "view_dashboard");
      businessId = args.business_id;
      scope = businessId ? "business" : "fleet";
    } else {
      businessId = await resolveMcpBusinessId(auth, args.business_id);
      await requireMcpBusinessRole(auth, businessId, "view_dashboard");
      scope = "business";
    }

    let rows: SystemLogWithBusiness[];
    try {
      rows = await listSystemLogsAll({ ...filters, businessId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpToolError(`Could not load system logs: ${message}`);
    }

    const limit = filters.limit;
    return {
      scope,
      logs: rows.map(toLogRow),
      next_before:
        rows.length === limit && rows.length > 0 ? rows[rows.length - 1].created_at : null
    };
  }
});

export const systemLogTools = [listSystemLogsTool];
