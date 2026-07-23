/**
 * Fleet-wide "Recent Activity" feed for the ADMIN dashboard.
 *
 * Why this exists: the admin card historically read only `coworker_logs`, a
 * table that receives little besides provisioning progress and a few tool
 * captures — so the card sat stale while the fleet was busy calling, texting,
 * emailing, and running AiFlows. This is the fleet-wide counterpart of the
 * owner dashboard's unified feed (src/lib/db/activity.ts, which fixed the
 * same staleness per-business): the same activity tables, queried across all
 * tenants, each item attributed to its business so the card can name and
 * deep-link the tenant.
 *
 * Kept deliberately simpler than the owner feed: no contact-name resolution
 * (fleet-wide would fan out per business; raw identifiers are fine for the
 * admin), no pagination (the card shows one bounded list). The pure
 * `buildFleetActivityFeed` shaper is split from the IO so it is unit-testable
 * under the 100% coverage gate.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { customerE164FromPayload } from "@/lib/db/sms-history";
import { adminAlertSummary } from "@/lib/admin/dashboard";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Badge variants the admin card renders (all exist on components/ui/Badge). */
export type FleetActivityVariant = "online" | "pending" | "neutral" | "success";

export type FleetActivityItem = {
  /** Stable React key, unique across all sources. */
  id: string;
  /** Chip text, e.g. "Call", "Text in", "Provisioning". */
  badge: string;
  variant: FleetActivityVariant;
  /** Human one-liner shown in the feed. */
  label: string;
  /** Owning tenant — the card names it and links to /admin/<id>. */
  businessId: string;
  /** ISO timestamp used for ordering and display. */
  at: string;
};

export type FleetCallRow = {
  business_id: string;
  caller_e164: string | null;
  status: string;
  started_at: string;
};

export type FleetSmsInboundRow = {
  business_id: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

/** A coworker reply stored on an inbound job, windowed on its own updated_at. */
export type FleetSmsReplyRow = {
  business_id: string;
  payload: Record<string, unknown> | null;
  updated_at: string;
};

export type FleetSmsOutboundRow = {
  business_id: string;
  to_e164: string | null;
  created_at: string;
};

export type FleetEmailRow = {
  business_id: string;
  direction: "outbound" | "inbound";
  to_email: string | null;
  from_email: string | null;
  subject: string | null;
  created_at: string;
};

export type FleetFlowRow = {
  business_id: string;
  status: string;
  created_at: string;
  ai_flows: { name: string } | { name: string }[] | null;
};

export type FleetCustomerRow = {
  business_id: string;
  display_name: string | null;
  customer_e164: string;
  created_at: string;
};

/** Completed coworker_logs rows (provisioning finishes, data flows, captures). */
export type FleetLogRow = {
  id: string;
  business_id: string;
  task_type: string;
  status: string;
  log_payload: Record<string, unknown> | null;
  created_at: string;
};

export type FleetActivityInput = {
  calls: FleetCallRow[];
  smsInbound: FleetSmsInboundRow[];
  smsReplies: FleetSmsReplyRow[];
  smsOutbound: FleetSmsOutboundRow[];
  emails: FleetEmailRow[];
  flows: FleetFlowRow[];
  customers: FleetCustomerRow[];
  logs: FleetLogRow[];
  /**
   * businessId → (E.164 → known contact name), from the shared
   * {@link resolveContactNames} resolver — nested because the fleet feed
   * spans tenants and the same number can name different people in
   * different businesses. Numbers absent from the map fall back to the raw
   * E.164. Defaults to empty when callers omit it.
   */
  contactNames?: Map<string, Map<string, ContactName>>;
  limit: number;
};

/** Resolve the joined flow name across Supabase's array/object/null shapes. */
function flowName(join: FleetFlowRow["ai_flows"]): string {
  const flow = Array.isArray(join) ? join[0] : join;
  return flow?.name ?? "AiFlow";
}

/**
 * Merge every fleet source into one chronological (newest-first) list capped
 * at `limit`. Pure — callers pass already-fetched plain rows.
 */
export function buildFleetActivityFeed(input: FleetActivityInput): FleetActivityItem[] {
  const items: FleetActivityItem[] = [];
  // Show a known contact's name instead of the raw E.164 wherever the
  // caller resolved one (same convention as the owner feed's `named`).
  const named = (businessId: string, e164: string): string =>
    input.contactNames?.get(businessId)?.get(e164)?.name ?? e164;

  input.calls.forEach((c, i) => {
    items.push({
      id: `call:${i}:${c.started_at}`,
      badge: "Call",
      variant: "online",
      label: `Call: ${
        c.caller_e164 ? named(c.business_id, c.caller_e164) : "unknown caller"
      } (${c.status})`,
      businessId: c.business_id,
      at: c.started_at
    });
  });

  input.smsInbound.forEach((r, i) => {
    const cp = customerE164FromPayload(r.payload);
    if (!cp) return;
    items.push({
      id: `sms_in:${i}:${r.created_at}`,
      badge: "Text in",
      variant: "pending",
      label: `Text from ${named(r.business_id, cp)}`,
      businessId: r.business_id,
      at: r.created_at
    });
  });

  input.smsReplies.forEach((r, i) => {
    const cp = customerE164FromPayload(r.payload);
    if (!cp) return;
    items.push({
      id: `sms_reply:${i}:${r.updated_at}`,
      badge: "Text out",
      variant: "neutral",
      label: `Text to ${named(r.business_id, cp)}`,
      businessId: r.business_id,
      at: r.updated_at
    });
  });

  input.smsOutbound.forEach((r, i) => {
    if (!r.to_e164) return;
    items.push({
      id: `sms_out:${i}:${r.created_at}`,
      badge: "Text out",
      variant: "neutral",
      label: `Text to ${named(r.business_id, r.to_e164)}`,
      businessId: r.business_id,
      at: r.created_at
    });
  });

  input.emails.forEach((r, i) => {
    const inbound = r.direction === "inbound";
    const who = (inbound ? r.from_email : r.to_email) ?? "unknown address";
    const subject = r.subject?.trim() ? `: “${r.subject.trim()}”` : "";
    items.push({
      id: `email:${i}:${r.created_at}`,
      badge: inbound ? "Email in" : "Email out",
      variant: inbound ? "pending" : "neutral",
      label: `${inbound ? "Email from" : "Email to"} ${who}${subject}`,
      businessId: r.business_id,
      at: r.created_at
    });
  });

  input.flows.forEach((r, i) => {
    items.push({
      id: `aiflow:${i}:${r.created_at}`,
      badge: "AiFlow",
      variant: "success",
      label: `AiFlow: ${flowName(r.ai_flows)} (${r.status})`,
      businessId: r.business_id,
      at: r.created_at
    });
  });

  input.customers.forEach((r, i) => {
    // Prefer a resolver name (owner/employee/override) over the row's own
    // display_name — same precedence as the owner feed.
    const resolved = input.contactNames?.get(r.business_id)?.get(r.customer_e164)?.name;
    const name = resolved ?? r.display_name?.trim();
    const who = name ? `${name} (${r.customer_e164})` : r.customer_e164;
    items.push({
      id: `customer:${i}:${r.created_at}`,
      badge: "New contact",
      variant: "pending",
      label: `New customer: ${who}`,
      businessId: r.business_id,
      at: r.created_at
    });
  });

  // Completed coworker_logs rows keep provisioning finishes and tool
  // activity in the feed; the alert-shaped rows live in Recent Alerts.
  input.logs.forEach((r) => {
    items.push({
      id: `log:${r.id}`,
      badge: r.task_type.replaceAll("_", " "),
      variant: "success",
      label: adminAlertSummary(r),
      businessId: r.business_id,
      at: r.created_at
    });
  });

  return items
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, input.limit);
}

/** Treat a failed query as "no rows" so one broken source never blanks the feed. */
function rowsOf<T>(res: { data: unknown; error: unknown }): T[] {
  return res.error ? [] : ((res.data ?? []) as T[]);
}

/**
 * How far back the fleet feed looks. Fleet-wide there is usually plenty of
 * fresh traffic; the bound just keeps a quiet week from surfacing months-old
 * rows as "recent".
 */
export const FLEET_ACTIVITY_WINDOW_DAYS = 30;

export type FleetActivityOptions = {
  /** Businesses muted from the admin activity feed (see db/admin-mutes.ts). */
  excludeBusinessIds?: string[];
};

/**
 * Fetch the most-recent activity across every tenant — calls, texts (both
 * directions), email traffic, AiFlow runs, new customers, and completed
 * coworker_logs work — merged into one chronological feed for the admin
 * dashboard's Recent Activity card, capped to `limit`.
 */
export async function getFleetRecentActivity(
  limit = 10,
  options?: FleetActivityOptions,
  client?: SupabaseClient
): Promise<FleetActivityItem[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const since = new Date(
    Date.now() - FLEET_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const excluded = options?.excludeBusinessIds ?? [];
  // Applied per source so a muted tenant can't eat any source's row budget.
  // `q` is the PostgREST builder mid-chain; `not`'s return is typed `any`
  // because a recursive structural constraint (not(): T) sends tsc into
  // TS2589 against the real builder generics (same trade-off as the owner
  // feed's beforeLt in src/lib/db/activity.ts) — only the chain shape
  // matters here.
  const notMuted = <T extends { not(column: string, op: string, value: string): any }>(
    q: T
  ) => (excluded.length > 0 ? q.not("business_id", "in", `(${excluded.join(",")})`) : q);

  const [callsRes, smsInRes, smsReplyRes, smsOutRes, emailRes, flowsRes, custRes, logsRes] =
    await Promise.all([
      notMuted(
        db
          .from("voice_call_transcripts")
          .select("business_id, caller_e164, status, started_at")
          .is("deleted_at", null)
          .gte("started_at", since)
      )
        .order("started_at", { ascending: false })
        .limit(limit),
      notMuted(
        db
          .from("sms_inbound_jobs")
          .select("business_id, payload, created_at")
          .is("deleted_at", null)
          .gte("created_at", since)
      )
        .order("created_at", { ascending: false })
        .limit(limit),
      // Replies windowed on updated_at (send time) so a recent reply to an
      // older inbound text still appears as outbound activity.
      notMuted(
        db
          .from("sms_inbound_jobs")
          .select("business_id, payload, updated_at")
          .is("deleted_at", null)
          .not("assistant_reply_text", "is", null)
          .gte("updated_at", since)
      )
        .order("updated_at", { ascending: false })
        .limit(limit),
      notMuted(
        db
          .from("sms_outbound_log")
          .select("business_id, to_e164, created_at")
          .is("deleted_at", null)
          .gte("created_at", since)
      )
        .order("created_at", { ascending: false })
        .limit(limit),
      notMuted(
        db
          .from("email_log")
          .select("business_id, direction, to_email, from_email, subject, created_at")
          .is("deleted_at", null)
          .gte("created_at", since)
      )
        .order("created_at", { ascending: false })
        .limit(limit),
      notMuted(
        db
          .from("ai_flow_runs")
          .select("business_id, status, created_at, ai_flows(name)")
          .gte("created_at", since)
      )
        .order("created_at", { ascending: false })
        .limit(limit),
      notMuted(
        db
          .from("contacts")
          // Only real customer profiles count — folded manual contacts
          // (vendors, testers) are not interactions (same rule as the
          // owner feed).
          .select("business_id, display_name, customer_e164, created_at")
          .eq("type", "customer")
          .gte("created_at", since)
      )
        .order("created_at", { ascending: false })
        .limit(limit),
      // Completed work only: alert-shaped rows (urgent_alert/error) live in
      // Recent Alerts, and `thinking` progress ticks are scaffolding.
      notMuted(
        db
          .from("coworker_logs")
          .select("id, business_id, task_type, status, log_payload, created_at")
          .eq("status", "success")
          .gte("created_at", since)
      )
        .order("created_at", { ascending: false })
        .limit(limit)
    ]);

  const calls = rowsOf<FleetCallRow>(callsRes);
  const smsInbound = rowsOf<FleetSmsInboundRow>(smsInRes);
  const smsReplies = rowsOf<FleetSmsReplyRow>(smsReplyRes);
  const smsOutbound = rowsOf<FleetSmsOutboundRow>(smsOutRes);
  const customers = rowsOf<FleetCustomerRow>(custRes);

  // Resolve every phone number the feed will show to a known contact name
  // (owner/employee/customer/override) via the shared resolver, per business
  // — "Text to Jane Doe" instead of a bare +1602… number. One resolver call
  // per distinct tenant in the window (bounded by the per-source row caps).
  // A resolver failure degrades that tenant to raw numbers, never blanks
  // the feed.
  const numbersByBusiness = new Map<string, Set<string>>();
  const want = (businessId: string, e164: string | null): void => {
    if (!e164) return;
    const set = numbersByBusiness.get(businessId) ?? new Set<string>();
    set.add(e164);
    numbersByBusiness.set(businessId, set);
  };
  for (const c of calls) want(c.business_id, c.caller_e164);
  for (const r of smsInbound) want(r.business_id, customerE164FromPayload(r.payload));
  for (const r of smsReplies) want(r.business_id, customerE164FromPayload(r.payload));
  for (const r of smsOutbound) want(r.business_id, r.to_e164);
  for (const r of customers) want(r.business_id, r.customer_e164);

  const contactNames = new Map<string, Map<string, ContactName>>();
  await Promise.all(
    [...numbersByBusiness.entries()].map(async ([businessId, nums]) => {
      const names = await resolveContactNames(businessId, [...nums], db).catch(
        () => new Map<string, ContactName>()
      );
      contactNames.set(businessId, names);
    })
  );

  return buildFleetActivityFeed({
    calls,
    smsInbound,
    smsReplies,
    smsOutbound,
    emails: rowsOf<FleetEmailRow>(emailRes),
    flows: rowsOf<FleetFlowRow>(flowsRes),
    customers,
    logs: rowsOf<FleetLogRow>(logsRes),
    contactNames,
    limit
  });
}
