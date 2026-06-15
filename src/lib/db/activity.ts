/**
 * Unified "Recent Activity" feed for the owner dashboard.
 *
 * Why this exists: the dashboard's Recent Activity card historically read only
 * `coworker_logs`, a table that nothing but voice caller-captures (and the
 * legacy Rowboat claw-log gateway) writes to — so it showed "No activity yet"
 * even for busy businesses with calls, texts, dashboard chat, and AiFlow runs.
 * The emailed digest already aggregates the REAL activity tables (see
 * supabase/functions/notifications-digest/index.ts + _shared/digest_builder.ts);
 * this module is the dashboard-side equivalent so the two surfaces agree.
 *
 * Unlike the digest (which produces window-scoped COUNTS for an email), this
 * returns the N most-recent activity items as a flat, chronologically-ordered
 * feed for direct rendering. The pure `buildActivityFeed` shaper is split from
 * the IO so it can be unit-tested under the 100% coverage gate.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { customerE164FromPayload } from "@/lib/db/sms-history";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ActivityKind =
  | "call"
  | "sms_inbound"
  | "sms_outbound"
  | "chat"
  | "aiflow"
  | "customer";

export type ActivityItem = {
  /** Stable React key, unique across all sources. */
  id: string;
  kind: ActivityKind;
  /** Human-readable one-liner shown in the feed. */
  label: string;
  /** Dashboard-relative deep link to the underlying record. */
  href: string;
  /** ISO timestamp used for ordering and display. */
  at: string;
};

export type ActivityCallRow = {
  caller_e164: string | null;
  status: string;
  started_at: string;
};

export type ActivitySmsInboundRow = {
  payload: Record<string, unknown> | null;
  created_at: string;
};

export type ActivitySmsOutboundRow = {
  to_e164: string | null;
  created_at: string;
};

export type ActivityChatRow = {
  created_at: string;
};

export type ActivityFlowRow = {
  status: string;
  created_at: string;
  ai_flows: { name: string } | { name: string }[] | null;
};

export type ActivityCustomerRow = {
  display_name: string | null;
  customer_e164: string;
  created_at: string;
};

export type ActivityFeedInput = {
  calls: ActivityCallRow[];
  smsInbound: ActivitySmsInboundRow[];
  smsOutbound: ActivitySmsOutboundRow[];
  chat: ActivityChatRow[];
  flows: ActivityFlowRow[];
  customers: ActivityCustomerRow[];
  limit: number;
};

/** Resolve the joined flow name across Supabase's array/object/null shapes. */
function flowName(join: ActivityFlowRow["ai_flows"]): string {
  const flow = Array.isArray(join) ? join[0] : join;
  return flow?.name ?? "AiFlow";
}

/**
 * Merge every activity source into one chronological (newest-first) feed,
 * capped at `limit`. Pure — callers pass already-fetched plain rows.
 */
export function buildActivityFeed(input: ActivityFeedInput): ActivityItem[] {
  const items: ActivityItem[] = [];

  input.calls.forEach((c, i) => {
    items.push({
      id: `call:${i}:${c.started_at}`,
      kind: "call",
      label: `Call — ${c.caller_e164 ?? "unknown caller"} (${c.status})`,
      href: "/dashboard/calls",
      at: c.started_at
    });
  });

  input.smsInbound.forEach((r, i) => {
    const cp = customerE164FromPayload(r.payload);
    if (!cp) return;
    items.push({
      id: `sms_in:${i}:${r.created_at}`,
      kind: "sms_inbound",
      label: `Text from ${cp}`,
      href: `/dashboard/messages/${encodeURIComponent(cp)}`,
      at: r.created_at
    });
  });

  input.smsOutbound.forEach((r, i) => {
    if (!r.to_e164) return;
    items.push({
      id: `sms_out:${i}:${r.created_at}`,
      kind: "sms_outbound",
      label: `Text to ${r.to_e164}`,
      href: `/dashboard/messages/${encodeURIComponent(r.to_e164)}`,
      at: r.created_at
    });
  });

  input.chat.forEach((r, i) => {
    items.push({
      id: `chat:${i}:${r.created_at}`,
      kind: "chat",
      label: "Dashboard chat",
      href: "/dashboard/chat",
      at: r.created_at
    });
  });

  input.flows.forEach((r, i) => {
    items.push({
      id: `aiflow:${i}:${r.created_at}`,
      kind: "aiflow",
      label: `AiFlow — ${flowName(r.ai_flows)} (${r.status})`,
      href: "/dashboard/aiflows",
      at: r.created_at
    });
  });

  input.customers.forEach((r, i) => {
    const who = r.display_name ? `${r.display_name} (${r.customer_e164})` : r.customer_e164;
    items.push({
      id: `customer:${i}:${r.created_at}`,
      kind: "customer",
      label: `New customer — ${who}`,
      href: `/dashboard/customers/${encodeURIComponent(r.customer_e164)}`,
      at: r.created_at
    });
  });

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, input.limit);
}

/** Treat a failed query as "no rows" so one broken source never blanks the feed. */
function rowsOf<T>(res: { data: unknown; error: unknown }): T[] {
  return res.error ? [] : ((res.data ?? []) as T[]);
}

export const DEFAULT_ACTIVITY_LIMIT = 10;

/**
 * Fetch the most-recent activity across calls, texts, dashboard chat, AiFlow
 * runs, and new customers for a business, merged into one chronological feed.
 * Each source is over-fetched to `limit` so the merge can't starve a source;
 * the builder caps the merged result back to `limit`.
 */
export async function getRecentActivity(
  businessId: string,
  limit: number = DEFAULT_ACTIVITY_LIMIT,
  client?: SupabaseClient
): Promise<ActivityItem[]> {
  const db = client ?? (await createSupabaseServiceClient());

  const [callsRes, smsInRes, smsOutRes, chatRes, flowsRes, custRes] = await Promise.all([
    db
      .from("voice_call_transcripts")
      .select("caller_e164, status, started_at")
      .eq("business_id", businessId)
      .order("started_at", { ascending: false })
      .limit(limit),
    db
      .from("sms_inbound_jobs")
      .select("payload, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("sms_outbound_log")
      .select("to_e164, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("dashboard_chat_jobs")
      .select("created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("ai_flow_runs")
      .select("status, created_at, ai_flows(name)")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("customer_memories")
      .select("display_name, customer_e164, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit)
  ]);

  return buildActivityFeed({
    calls: rowsOf<ActivityCallRow>(callsRes),
    smsInbound: rowsOf<ActivitySmsInboundRow>(smsInRes),
    smsOutbound: rowsOf<ActivitySmsOutboundRow>(smsOutRes),
    chat: rowsOf<ActivityChatRow>(chatRes),
    flows: rowsOf<ActivityFlowRow>(flowsRes),
    customers: rowsOf<ActivityCustomerRow>(custRes),
    limit
  });
}
