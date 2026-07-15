/**
 * Read-only MCP tools: business info, contacts, message threads, recent
 * events, call transcripts, and the Task Center's leads-in-motion view.
 *
 * Every tool is tenant-scoped and role-gated through the central
 * permission matrix — reads use the same action each surface's dashboard
 * route requires (`view_dashboard` for dashboards, `operate_messages` for
 * contact/thread content), so a Claude connector can never see more than
 * the same login sees in the dashboard.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId,
  toAuthUser,
  type McpAuthUser
} from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import {
  WEBHOOK_EVENT_SOURCES,
  WEBHOOK_EVENT_TYPES,
  buildWebhookPayload,
  isWebhookEventType,
  type WebhookSourceRow
} from "../../../../supabase/functions/_shared/webhook_events";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Business to operate on. Optional when the account has exactly one business; otherwise call list_businesses first."
  );

/** Coerce owner-typed phone input to E.164 / short code, or refuse. */
export function normalizePhoneArg(raw: string): string {
  const result = normalizeContactNumber(raw);
  if (!result.ok) throw new McpToolError(`Invalid phone number: ${result.reason}`);
  return result.value;
}

export const listBusinessesTool = defineMcpTool({
  name: "list_businesses",
  description:
    "List every New Coworker business this account can access, with the caller's role on each (owner, manager, or staff). Call this first when other tools report the account has multiple businesses.",
  schema: {},
  handler: async (_args, auth: McpAuthUser) => {
    const { listAccessibleBusinesses } = await import("@/lib/dashboard/active-business");
    const accessible = await listAccessibleBusinesses(toAuthUser(auth));
    return {
      businesses: accessible.map((b) => ({
        business_id: b.businessId,
        name: b.name,
        tier: b.tier,
        role: b.role
      }))
    };
  }
});

export const getBusinessTool = defineMcpTool({
  name: "get_business",
  description:
    "Get one business's profile: name, plan tier, status, and timezone.",
  schema: { business_id: businessIdField },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "view_dashboard");
    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("businesses")
      .select("id, name, tier, status, timezone, created_at")
      .eq("id", businessId)
      .maybeSingle();
    if (error || !data) throw new McpToolError("Business not found.");
    return {
      business_id: data.id,
      name: data.name,
      tier: data.tier,
      status: data.status,
      timezone: data.timezone ?? null,
      created_at: data.created_at
    };
  }
});

export const searchContactsTool = defineMcpTool({
  name: "search_contacts",
  description:
    "Search the business's contacts (CRM) by name or phone substring. Returns basic profile info per contact; use get_contact for the full profile including notes and AI memory.",
  schema: {
    business_id: businessIdField,
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe("Name or phone substring; omit to list the most recent contacts."),
    limit: z.number().int().min(1).max(200).optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const { listCustomerMemories } = await import("@/lib/customer-memory/db");
    const rows = await listCustomerMemories(businessId, {
      search: args.search,
      limit: args.limit ?? 50
    });
    return {
      contacts: rows.map((row) => ({
        phone: row.customer_e164,
        name: row.display_name,
        type: row.type,
        tags: row.tags,
        last_channel: row.last_channel,
        last_interaction_at: row.last_interaction_at,
        total_interactions: row.total_interaction_count
      }))
    };
  }
});

export const getContactTool = defineMcpTool({
  name: "get_contact",
  description:
    "Get one contact's full profile: name, email, tags, owner, birthday, pinned notes, and the AI's rolling relationship summary.",
  schema: {
    business_id: businessIdField,
    phone: z.string().describe("The contact's phone number (any common format).")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const phone = normalizePhoneArg(args.phone);
    const { getCustomerMemory } = await import("@/lib/customer-memory/db");
    const row = await getCustomerMemory(businessId, phone);
    if (!row) throw new McpToolError(`No contact found for ${phone}.`);
    return {
      phone: row.customer_e164,
      name: row.display_name,
      email: row.email,
      type: row.type,
      tags: row.tags,
      owner_employee_id: row.owner_employee_id,
      birthday: row.birthday,
      pinned_notes: row.pinned_md,
      ai_summary: row.summary_md,
      last_channel: row.last_channel,
      last_interaction_at: row.last_interaction_at,
      total_interactions: row.total_interaction_count
    };
  }
});

export const getSmsThreadTool = defineMcpTool({
  name: "get_sms_thread",
  description:
    "Read the SMS/RCS conversation with one contact, oldest to newest — inbound texts, the AI coworker's replies, and workflow/manual sends.",
  schema: {
    business_id: businessIdField,
    phone: z.string().describe("The contact's phone number (any common format)."),
    limit: z.number().int().min(1).max(200).optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const phone = normalizePhoneArg(args.phone);
    const { listMessagesForCustomer } = await import("@/lib/db/sms-history");
    const messages = await listMessagesForCustomer(businessId, phone, {
      limit: args.limit ?? 50
    });
    return {
      phone,
      messages: messages.map((m) => ({
        direction: m.direction,
        text: m.content,
        at: m.timestamp,
        ...(m.source ? { source: m.source } : {}),
        ...(m.channel ? { channel: m.channel } : {})
      }))
    };
  }
});

export const listRecentEventsTool = defineMcpTool({
  name: "list_recent_events",
  description:
    `Recent activity events for the business, newest first. Event types: ${WEBHOOK_EVENT_TYPES.join(", ")}. Payloads match the business's outbound webhook format.`,
  schema: {
    business_id: businessIdField,
    event: z
      .string()
      .describe(`One of: ${WEBHOOK_EVENT_TYPES.join(", ")}`),
    limit: z.number().int().min(1).max(25).optional()
  },
  handler: async (args, auth) => {
    const event = args.event;
    if (!isWebhookEventType(event)) {
      throw new McpToolError(`event must be one of: ${WEBHOOK_EVENT_TYPES.join(", ")}`);
    }
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "view_dashboard");
    const source = WEBHOOK_EVENT_SOURCES[event];
    const db = await createSupabaseServiceClient();
    let query = db
      .from(source.table)
      .select(source.select)
      .eq("business_id", businessId)
      .order(source.cursorColumn, { ascending: false })
      .limit(args.limit ?? 10);
    if (source.filter) {
      const [column, operator, value] = source.filter;
      query = query.filter(column, operator, value);
    }
    if (source.readyOr) {
      // Same readiness gate as the webhook dispatcher (e.g. call summaries).
      query = query.or(source.readyOr(Date.now()));
    }
    const { data, error } = await query;
    if (error) throw new McpToolError(`Could not load events: ${error.message}`);
    const rows = (data ?? []) as unknown as WebhookSourceRow[];
    return { events: rows.map((row) => buildWebhookPayload(event, row)) };
  }
});

export const listCallTranscriptsTool = defineMcpTool({
  name: "list_call_transcripts",
  description:
    "List the business's recent phone calls (AI-handled and human-forwarded), newest first, with status, AI summary, and sentiment when available.",
  schema: {
    business_id: businessIdField,
    limit: z.number().int().min(1).max(100).optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "view_dashboard");
    const { listTranscriptsForBusiness } = await import("@/lib/db/voice-transcripts");
    const rows = await listTranscriptsForBusiness(businessId, {
      limit: args.limit ?? 25
    });
    return {
      calls: rows.map((row) => ({
        id: row.id,
        caller: row.caller_e164,
        direction: row.direction,
        kind: row.call_kind,
        status: row.status,
        started_at: row.started_at,
        ended_at: row.ended_at,
        summary: row.summary,
        sentiment: row.sentiment
      }))
    };
  }
});

export const listTasksTool = defineMcpTool({
  name: "list_tasks",
  description:
    "The business's leads in motion: contacts with active AiFlow workflow runs (with each run's flow and status) plus lead-state tagged contacts — the same data behind the dashboard Task Center.",
  schema: {
    business_id: businessIdField,
    limit: z.number().int().min(1).max(100).optional()
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "view_dashboard");
    const limit = args.limit ?? 30;
    const db = await createSupabaseServiceClient();

    const { ACTIVE_RUN_STATUSES, taskLeadPhone } = await import("@/lib/ai-flows/tasks");
    const { data: runData, error: runErr } = await db
      .from("ai_flow_runs")
      .select("id, flow_id, status, context, updated_at")
      .eq("business_id", businessId)
      .in("status", [...ACTIVE_RUN_STATUSES])
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (runErr) throw new McpToolError(`Could not load workflow runs: ${runErr.message}`);
    const runs = (runData ?? []) as Array<{
      id: string;
      flow_id: string;
      status: string;
      context: Record<string, unknown> | null;
      updated_at: string;
    }>;

    const flowNames = new Map<string, string>();
    const flowIds = [...new Set(runs.map((r) => r.flow_id))];
    if (flowIds.length > 0) {
      const { data: flowData, error: flowErr } = await db
        .from("ai_flows")
        .select("id, name")
        .in("id", flowIds);
      if (flowErr) throw new McpToolError(`Could not load flows: ${flowErr.message}`);
      for (const f of (flowData ?? []) as Array<{ id: string; name: string }>) {
        flowNames.set(f.id, f.name);
      }
    }

    const { data: tagged, error: tagErr } = await db
      .from("contacts")
      .select("customer_e164, display_name, tags, updated_at")
      .eq("business_id", businessId)
      .neq("tags", "{}")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (tagErr) throw new McpToolError(`Could not load tagged contacts: ${tagErr.message}`);

    return {
      active_runs: runs.map((run) => ({
        run_id: run.id,
        flow: flowNames.get(run.flow_id) ?? "AiFlow",
        status: run.status,
        lead_phone: taskLeadPhone(run.context ?? {}),
        updated_at: run.updated_at
      })),
      tagged_contacts: ((tagged ?? []) as Array<{
        customer_e164: string;
        display_name: string | null;
        tags: string[] | null;
        updated_at: string;
      }>).map((c) => ({
        phone: c.customer_e164,
        name: c.display_name,
        tags: c.tags ?? [],
        updated_at: c.updated_at
      }))
    };
  }
});

export const readTools = [
  listBusinessesTool,
  getBusinessTool,
  searchContactsTool,
  getContactTool,
  getSmsThreadTool,
  listRecentEventsTool,
  listCallTranscriptsTool,
  listTasksTool
];
