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
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ActivityKind =
  | "call"
  | "sms_inbound"
  | "sms_outbound"
  | "chat"
  | "aiflow"
  | "customer"
  | "alert";

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

/**
 * A coworker reply stored on an inbound job. Queried on its own `updated_at`
 * window (not `created_at`) so a reply sent recently to an older inbound text
 * still appears — matching the digest's reply accounting.
 */
export type ActivitySmsReplyRow = {
  payload: Record<string, unknown> | null;
  updated_at: string;
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

export type ActivityAlertRow = {
  task_type: string;
  log_payload: Record<string, unknown> | null;
  created_at: string;
};

export type ActivityFeedInput = {
  calls: ActivityCallRow[];
  smsInbound: ActivitySmsInboundRow[];
  smsReplies: ActivitySmsReplyRow[];
  smsOutbound: ActivitySmsOutboundRow[];
  chat: ActivityChatRow[];
  flows: ActivityFlowRow[];
  customers: ActivityCustomerRow[];
  alerts: ActivityAlertRow[];
  /**
   * E.164 → known contact name (owner/employee/customer/override), from the
   * shared {@link resolveContactNames} resolver. Numbers absent from the map
   * fall back to the raw E.164. Defaults to empty when callers omit it.
   */
  contactNames?: Map<string, ContactName>;
  limit: number;
};

/** Resolve the joined flow name across Supabase's array/object/null shapes. */
function flowName(join: ActivityFlowRow["ai_flows"]): string {
  const flow = Array.isArray(join) ? join[0] : join;
  return flow?.name ?? "AiFlow";
}

/** Pull a non-empty string field off a coworker_logs payload, else null. */
function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const raw = payload?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Human label for an urgent coworker_logs entry (urgent caller capture etc.). */
function alertLabel(row: ActivityAlertRow): string {
  const detail =
    payloadString(row.log_payload, "reason") ??
    payloadString(row.log_payload, "callerName") ??
    row.task_type.replace(/_/g, " ");
  return `Urgent — ${detail}`;
}

/**
 * Merge every activity source into one chronological (newest-first) feed,
 * capped at `limit`. Pure — callers pass already-fetched plain rows.
 */
export function buildActivityFeed(input: ActivityFeedInput): ActivityItem[] {
  const items: ActivityItem[] = [];
  // Show a known contact's name instead of the raw E.164 wherever we have one.
  const named = (e164: string): string => input.contactNames?.get(e164)?.name ?? e164;

  input.calls.forEach((c, i) => {
    items.push({
      id: `call:${i}:${c.started_at}`,
      kind: "call",
      label: `Call — ${c.caller_e164 ? named(c.caller_e164) : "unknown caller"} (${c.status})`,
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
      label: `Text from ${named(cp)}`,
      href: `/dashboard/messages/${encodeURIComponent(cp)}`,
      at: r.created_at
    });
  });

  // Coworker replies live on the inbound job (assistant_reply_text); they're
  // queried on their own updated_at window so a recent reply to an older text
  // still surfaces as outbound activity.
  input.smsReplies.forEach((r, i) => {
    const cp = customerE164FromPayload(r.payload);
    if (!cp) return;
    items.push({
      id: `sms_reply:${i}:${r.updated_at}`,
      kind: "sms_outbound",
      label: `Text to ${named(cp)}`,
      href: `/dashboard/messages/${encodeURIComponent(cp)}`,
      at: r.updated_at
    });
  });

  input.smsOutbound.forEach((r, i) => {
    if (!r.to_e164) return;
    items.push({
      id: `sms_out:${i}:${r.created_at}`,
      kind: "sms_outbound",
      label: `Text to ${named(r.to_e164)}`,
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

  input.alerts.forEach((r, i) => {
    items.push({
      id: `alert:${i}:${r.created_at}`,
      kind: "alert",
      label: alertLabel(r),
      href: "/dashboard/notifications",
      at: r.created_at
    });
  });

  // Alerts are high-signal but mustn't dominate: reserve at most half the feed
  // for the newest alerts so a backlog of urgent items can't hide the latest
  // calls/texts, fill the rest by recency, then backfill any unused slots with
  // extra alerts when there isn't enough other activity. Displayed newest-first.
  const byRecency = (a: ActivityItem, b: ActivityItem) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
  const alerts = items.filter((i) => i.kind === "alert").sort(byRecency);
  const rest = items.filter((i) => i.kind !== "alert").sort(byRecency);
  const reserve = Math.ceil(input.limit / 2);
  const reservedAlerts = alerts.slice(0, reserve);
  const keptRest = rest.slice(0, input.limit - reservedAlerts.length);
  const extraAlerts = alerts.slice(reservedAlerts.length, input.limit - keptRest.length);
  return [...reservedAlerts, ...extraAlerts, ...keptRest].sort(byRecency);
}

/** Treat a failed query as "no rows" so one broken source never blanks the feed. */
function rowsOf<T>(res: { data: unknown; error: unknown }): T[] {
  return res.error ? [] : ((res.data ?? []) as T[]);
}

export const DEFAULT_ACTIVITY_LIMIT = 10;

/**
 * How far back the feed looks. Bounding the window keeps "Recent Activity"
 * actually recent — without it, a long-idle business would surface months-old
 * rows (e.g. a stale `customer_memories` row mislabeled "New customer").
 * Mirrors the digest's windowed aggregation.
 */
export const ACTIVITY_WINDOW_DAYS = 30;

/**
 * Fetch the most-recent activity across calls, texts, dashboard chat, AiFlow
 * runs, new customers, and urgent alerts for a business, merged into one
 * chronological feed and bounded to the last {@link ACTIVITY_WINDOW_DAYS} days.
 * Each source is over-fetched to `limit` so the merge can't starve a source;
 * the builder caps the merged result back to `limit`.
 */
export async function getRecentActivity(
  businessId: string,
  limit: number = DEFAULT_ACTIVITY_LIMIT,
  client?: SupabaseClient
): Promise<ActivityItem[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [callsRes, smsInRes, smsReplyRes, smsOutRes, chatRes, flowsRes, custRes, alertRes] =
    await Promise.all([
      db
        .from("voice_call_transcripts")
        .select("caller_e164, status, started_at")
        .eq("business_id", businessId)
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(limit),
      db
        .from("sms_inbound_jobs")
        .select("payload, created_at")
        .eq("business_id", businessId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      // Replies windowed on updated_at (send time) so a recent reply to an
      // older inbound text still appears as outbound activity.
      db
        .from("sms_inbound_jobs")
        .select("payload, updated_at")
        .eq("business_id", businessId)
        .not("assistant_reply_text", "is", null)
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(limit),
      db
        .from("sms_outbound_log")
        .select("to_e164, created_at")
        .eq("business_id", businessId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      db
        .from("dashboard_chat_jobs")
        .select("created_at")
        .eq("business_id", businessId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      db
        .from("ai_flow_runs")
        .select("status, created_at, ai_flows(name)")
        .eq("business_id", businessId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      db
        .from("customer_memories")
        .select("display_name, customer_e164, created_at")
        .eq("business_id", businessId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      // High-signal coworker_logs entries: urgent alerts only. These are the
      // ones dispatched to the notifications page (see evaluateUrgency), so the
      // "/dashboard/notifications" deep link always resolves to the event.
      // `error` rows are intentionally excluded — they aren't dispatched
      // anywhere owner-facing, so there's no page to link them to.
      db
        .from("coworker_logs")
        .select("task_type, log_payload, created_at")
        .eq("business_id", businessId)
        .eq("status", "urgent_alert")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit)
    ]);

  const calls = rowsOf<ActivityCallRow>(callsRes);
  const smsInbound = rowsOf<ActivitySmsInboundRow>(smsInRes);
  const smsReplies = rowsOf<ActivitySmsReplyRow>(smsReplyRes);
  const smsOutbound = rowsOf<ActivitySmsOutboundRow>(smsOutRes);
  const customers = rowsOf<ActivityCustomerRow>(custRes);

  // Resolve every phone number the feed will show to a known contact name
  // (owner/employee/customer/override) via the shared converter, so the SMS
  // and call lines read "Text to Mike Haas" instead of a bare +1602… number.
  // A resolver failure must never blank the feed, so fall back to no names.
  const e164s = [
    ...calls.map((c) => c.caller_e164),
    ...smsInbound.map((r) => customerE164FromPayload(r.payload)),
    ...smsReplies.map((r) => customerE164FromPayload(r.payload)),
    ...smsOutbound.map((r) => r.to_e164),
    ...customers.map((r) => r.customer_e164)
  ].filter((x): x is string => Boolean(x));
  const contactNames = await resolveContactNames(businessId, e164s, db).catch(
    () => new Map<string, ContactName>()
  );

  return buildActivityFeed({
    calls,
    smsInbound,
    smsReplies,
    smsOutbound,
    chat: rowsOf<ActivityChatRow>(chatRes),
    flows: rowsOf<ActivityFlowRow>(flowsRes),
    customers,
    alerts: rowsOf<ActivityAlertRow>(alertRes),
    contactNames,
    limit
  });
}
