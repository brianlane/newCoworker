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
import { taskLeadPhone } from "@/lib/ai-flows/tasks";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ActivityKind =
  | "call"
  | "sms_inbound"
  | "sms_outbound"
  | "email_inbound"
  | "email_outbound"
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
  /**
   * The person this event belongs to (E.164), when the source row carries
   * one. Lets feed surfaces deep-link to the contact page / task board, and
   * lets contact-scoped consumers group items by person.
   */
  contactE164?: string;
  /**
   * Set when an outbound message was sent BY an AiFlow (`source = 'ai_flow'`
   * on `sms_outbound_log` / `email_log`). Render sites add the green AiFlow
   * chip next to the kind badge so automation traffic is recognizable at a
   * glance on any message type.
   */
  origin?: "aiflow";
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
  /**
   * `sms_outbound_log.source` — tags the send's origin in the feed:
   * `ai_flow` renders as "(AiFlow)". Optional so contact-scoped callers
   * that predate the tag keep compiling.
   */
  source?: string | null;
  created_at: string;
};

export type ActivityChatRow = {
  created_at: string;
};

/** One `email_log` row: coworker email activity (AiFlow sends, assistant
 * sends, trigger emails, tenant mailbox traffic). */
export type ActivityEmailRow = {
  direction: "outbound" | "inbound";
  to_email: string | null;
  from_email: string | null;
  subject: string | null;
  /** `email_log.source` — `ai_flow` tags the row as a flow send. */
  source?: string | null;
  created_at: string;
};

export type ActivityFlowRow = {
  /** The run id — deep-links the feed item straight to this run's detail. */
  id: string;
  /** The owning flow id — scopes the runs page so the run is in view. */
  flow_id: string;
  status: string;
  created_at: string;
  ai_flows: { name: string } | { name: string }[] | null;
  /**
   * The run's lead phone, when the caller resolved it (contact-scoped
   * fetches do; the business-wide feed leaves it unset to avoid parsing
   * every run's context).
   */
  lead_e164?: string | null;
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

/**
 * Owner-chosen narrowing of the full activity page, from the filter bar's URL
 * params. Applied at the FETCH layer (not post-merge) so every chunk is full
 * of the requested kinds — filtering the merged chunk client-side would show
 * near-empty pages for low-frequency kinds and waste the row budget on
 * excluded sources.
 */
export type ActivityFilter = {
  /** Kinds to include. Undefined or empty = all kinds. */
  kinds?: ActivityKind[];
  /**
   * Look-back in days. Always clamped to the tier's window server-side, so a
   * crafted URL can't widen a starter tenant past its 7-day view.
   */
  sinceDays?: number;
};

/** Every activity kind, in the order the filter bar shows them (keep in
 * lockstep with the ACTIVITY_BADGE key order the chips actually render from). */
export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "aiflow",
  "call",
  "sms_inbound",
  "sms_outbound",
  "email_inbound",
  "email_outbound",
  "chat",
  "customer",
  "alert"
] as const;

/**
 * Parse the `kinds` URL param (comma-separated) into valid kinds, dropping
 * anything outside the union and de-duplicating. Empty result = no filter.
 */
export function parseActivityKindsParam(raw: string | undefined): ActivityKind[] {
  if (!raw) return [];
  const valid = new Set<string>(ACTIVITY_KINDS);
  return [...new Set(raw.split(","))].filter((k): k is ActivityKind => valid.has(k));
}

/**
 * Parse the `days` URL param into a positive whole look-back, or undefined for
 * anything malformed/non-positive (= full tier window). The fetch layer clamps
 * to the tier window, so an oversized value merely means "everything".
 */
export function parseActivityDaysParam(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export type ActivityFeedInput = {
  calls: ActivityCallRow[];
  smsInbound: ActivitySmsInboundRow[];
  smsReplies: ActivitySmsReplyRow[];
  smsOutbound: ActivitySmsOutboundRow[];
  emails: ActivityEmailRow[];
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
  return `Urgent: ${detail}`;
}

/**
 * Build the unsorted list of activity items from every source. Pure and shared
 * by both the dashboard card ({@link buildActivityFeed}, which caps to the
 * card's limit) and the full "See all activity" page
 * ({@link paginateFullActivityFeed}, which chunks with a cursor). Both rank
 * strictly by recency; splitting the collection from the ordering keeps the
 * two surfaces in lockstep on what counts as activity.
 */
export function collectActivityItems(input: ActivityFeedInput): ActivityItem[] {
  const items: ActivityItem[] = [];
  // Show a known contact's name instead of the raw E.164 wherever we have one.
  const named = (e164: string): string => input.contactNames?.get(e164)?.name ?? e164;

  input.calls.forEach((c, i) => {
    items.push({
      id: `call:${i}:${c.started_at}`,
      kind: "call",
      label: `Call: ${c.caller_e164 ? named(c.caller_e164) : "unknown caller"} (${c.status})`,
      href: "/dashboard/calls",
      at: c.started_at,
      ...(c.caller_e164 ? { contactE164: c.caller_e164 } : {})
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
      at: r.created_at,
      contactE164: cp
    });
  });

  // Coworker replies live on the inbound job (assistant_reply_text); they're
  // queried on their own updated_at window so a recent reply to an older text
  // still surfaces as outbound activity. "Reply to" (not "Text to") tags the
  // send's origin: the AI answered an inbound text.
  input.smsReplies.forEach((r, i) => {
    const cp = customerE164FromPayload(r.payload);
    if (!cp) return;
    items.push({
      id: `sms_reply:${i}:${r.updated_at}`,
      kind: "sms_outbound",
      label: `Reply to ${named(cp)}`,
      href: `/dashboard/messages/${encodeURIComponent(cp)}`,
      at: r.updated_at,
      contactE164: cp
    });
  });

  input.smsOutbound.forEach((r, i) => {
    if (!r.to_e164) return;
    items.push({
      id: `sms_out:${i}:${r.created_at}`,
      kind: "sms_outbound",
      label: `Text to ${named(r.to_e164)}`,
      href: `/dashboard/messages/${encodeURIComponent(r.to_e164)}`,
      at: r.created_at,
      contactE164: r.to_e164,
      // Flow-driven sends carry the AiFlow origin so render sites add the
      // green chip — automation traffic is recognizable at a glance.
      ...(r.source === "ai_flow" ? { origin: "aiflow" as const } : {})
    });
  });

  input.emails.forEach((r, i) => {
    const inbound = r.direction === "inbound";
    const who = (inbound ? r.from_email : r.to_email) ?? "unknown address";
    const subject = r.subject?.trim() ? `: “${r.subject.trim()}”` : "";
    items.push({
      id: `email:${i}:${r.created_at}`,
      kind: inbound ? "email_inbound" : "email_outbound",
      label: `${inbound ? "Email from" : "Email to"} ${who}${subject}`,
      href: "/dashboard/emails",
      at: r.created_at,
      // Same AiFlow origin tag as texts — the badge applies to any message
      // type a flow can send (outbound only; 'ai_flow' is a send source).
      ...(!inbound && r.source === "ai_flow" ? { origin: "aiflow" as const } : {})
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
      label: `AiFlow: ${flowName(r.ai_flows)} (${r.status})`,
      // Deep-link to this exact run on the flow's runs page so clicking a
      // failed run opens its steps/error (and screenshots), not the flow list.
      href: `/dashboard/aiflows/runs?flowId=${encodeURIComponent(r.flow_id)}&run=${encodeURIComponent(r.id)}`,
      at: r.created_at,
      ...(r.lead_e164 ? { contactE164: r.lead_e164 } : {})
    });
  });

  input.customers.forEach((r, i) => {
    // Prefer a resolver name (owner/employee/override/customer) over the row's
    // own display_name, so a known contact is shown even when the auto-created
    // customer profile has no display_name of its own.
    const name = input.contactNames?.get(r.customer_e164)?.name ?? r.display_name ?? null;
    const who = name ? `${name} (${r.customer_e164})` : r.customer_e164;
    items.push({
      id: `customer:${i}:${r.created_at}`,
      kind: "customer",
      label: `New customer: ${who}`,
      href: `/dashboard/customers/${encodeURIComponent(r.customer_e164)}`,
      at: r.created_at,
      contactE164: r.customer_e164
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

  return items;
}

/** Newest-first comparator on the ISO `at` field; stable for equal timestamps. */
function byRecency(a: ActivityItem, b: ActivityItem): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
}

/**
 * Merge every activity source into one chronological (newest-first) feed,
 * capped at `limit`. Pure — callers pass already-fetched plain rows.
 *
 * Used by the dashboard's compact Recent Activity card. Alerts rank like every
 * other kind — strictly by recency — so an old urgent item scrolls away as
 * newer activity arrives instead of staying pinned (the notifications page
 * remains the durable home for alerts). This matches the full "See all
 * activity" page ({@link paginateFullActivityFeed}).
 */
export function buildActivityFeed(input: ActivityFeedInput): ActivityItem[] {
  return collectActivityItems(input).sort(byRecency).slice(0, input.limit);
}

export type ActivityFeedPage = {
  items: ActivityItem[];
  /**
   * Cursor for the next-older chunk (pass back as `before`), or null when the
   * window is exhausted. Timestamps are ms-precision; distinct events sharing
   * the exact cursor millisecond could be skipped across a chunk boundary — an
   * accepted trade-off for cursor paging without a global sequence.
   */
  nextBefore: string | null;
};

/**
 * Timestamps each source was fetched down to, for sources that HIT their
 * per-source row cap (ordered newest-first, so the last row is the oldest
 * fetched). A capped source may have older rows we never saw; anything below
 * the NEWEST such boundary is potentially incomplete.
 */
function cappedSourceBoundaries(input: ActivityFeedInput): string[] {
  const oldestOfCapped = (rows: Array<Record<string, unknown>>, key: string): string | null => {
    if (rows.length < input.limit || rows.length === 0) return null;
    // Walk up from the oldest fetched row to the first parseable timestamp:
    // a malformed row (shouldn't happen for timestamptz columns, but fail
    // safe) must not make a CAPPED source look uncapped — that would end
    // paging early and reintroduce the merge gap.
    for (let i = rows.length - 1; i >= 0; i--) {
      const at = rows[i]?.[key];
      if (typeof at === "string") return at;
    }
    return null;
  };
  return [
    oldestOfCapped(input.calls, "started_at"),
    oldestOfCapped(input.smsInbound, "created_at"),
    oldestOfCapped(input.smsReplies, "updated_at"),
    oldestOfCapped(input.smsOutbound, "created_at"),
    oldestOfCapped(input.emails, "created_at"),
    oldestOfCapped(input.chat, "created_at"),
    oldestOfCapped(input.flows, "created_at"),
    oldestOfCapped(input.customers, "created_at"),
    oldestOfCapped(input.alerts, "created_at")
  ].filter((x): x is string => Boolean(x));
}

/**
 * Merge one CHUNK of the full-page feed and compute the cursor for the next
 * one. The subtlety: each source is fetched with its own row cap, so a chatty
 * source (say 200 texts in two days) stops early while quieter sources run the
 * whole window — naively merging would show quiet-source items from BELOW the
 * chatty source's fetch depth while silently missing the texts between. To
 * keep every chunk gap-free:
 *
 *   1. Find the NEWEST "oldest fetched row" among sources that hit their cap —
 *      the merged feed is only complete above that boundary.
 *   2. Keep merged items at/above the boundary (capped at `limit`).
 *   3. Point `nextBefore` at the last KEPT item, so the next chunk re-queries
 *      every source strictly below it.
 *
 * When no source hit its cap the merged set is the complete remainder of the
 * window: page it out and stop (nextBefore null) once it's all been shown.
 */
export function paginateFullActivityFeed(input: ActivityFeedInput): ActivityFeedPage {
  const merged = collectActivityItems(input).sort(byRecency);
  const boundaries = cappedSourceBoundaries(input);

  if (boundaries.length === 0) {
    const items = merged.slice(0, input.limit);
    return {
      items,
      nextBefore: merged.length > input.limit ? items[items.length - 1]!.at : null
    };
  }

  // Newest incomplete-source boundary. The boundary row was fetched, but the
  // collector may have DROPPED it (e.g. an SMS job without a parsable phone),
  // so the filtered chunk can legitimately come back empty — advance the
  // cursor to the boundary itself in that case so paging always makes
  // progress (the next fetch is strictly below it) instead of throwing.
  const boundary = boundaries.reduce((a, b) => (a > b ? a : b));
  const items = merged.filter((i) => i.at >= boundary).slice(0, input.limit);
  const nextBefore = items.length > 0 ? items[items.length - 1]!.at : boundary;
  return { items, nextBefore };
}

/** Treat a failed query as "no rows" so one broken source never blanks the feed. */
function rowsOf<T>(res: { data: unknown; error: unknown }): T[] {
  return res.error ? [] : ((res.data ?? []) as T[]);
}

export const DEFAULT_ACTIVITY_LIMIT = 10;

/**
 * Upper bound on rows loaded for the full "See all activity" page. The page
 * paginates client-side over an already-bounded set (mirroring the calls/texts/
 * emails list views), so this caps memory + query cost while still being deep
 * enough that AiFlow runs and other lower-frequency events — which the 10-item
 * dashboard card crowds out — are actually reachable.
 */
export const ACTIVITY_FEED_MAX = 200;

/**
 * How far back the feed looks, by tier. Bounding the window keeps "Recent
 * Activity" actually recent — without it, a long-idle business would surface
 * months-old rows (e.g. a stale `customer_memories` row mislabeled "New
 * customer").
 *
 * Tier relaunch decision (Jul 2026): activity history depth is a Standard/
 * Enterprise perk. Starter keeps the week-at-a-glance view (7 days); Standard
 * and Enterprise get a full quarter (90 days). This is a VIEW window only —
 * nothing is deleted, so an upgrade instantly reveals the older history.
 */
export const ACTIVITY_WINDOW_DAYS_STARTER = 7;
export const ACTIVITY_WINDOW_DAYS_STANDARD = 90;

/** Legacy default window, kept for callers that don't pass a tier. */
export const ACTIVITY_WINDOW_DAYS = 30;

/** Resolve the feed window for a tier (unknown/null tiers get the legacy 30). */
export function activityWindowDays(tier: string | null | undefined): number {
  if (tier === "starter") return ACTIVITY_WINDOW_DAYS_STARTER;
  if (tier === "standard" || tier === "enterprise") return ACTIVITY_WINDOW_DAYS_STANDARD;
  return ACTIVITY_WINDOW_DAYS;
}

/**
 * Fetch every activity source for a business, bounded to the last
 * {@link ACTIVITY_WINDOW_DAYS} days and over-fetched to `limit` per source so
 * the downstream merge can't starve any one source. Resolves contact names for
 * every phone-bearing row. Shared by {@link getRecentActivity} (card) and
 * {@link getActivityFeedPage} (full page) so the two surfaces read identical
 * data and differ only in how they rank/cap it.
 *
 * `before` is the cursor for the full page's older chunks: every source is
 * additionally bounded to rows STRICTLY OLDER than it (on the same timestamp
 * column it orders by), so "Older activity" walks the whole window instead of
 * stopping at the first `limit` rows.
 *
 * `filter` narrows kinds and the look-back at the fetch layer: a source whose
 * kinds are all excluded is never queried (it resolves to no rows, which the
 * chunk pagination already treats as "never capped"), and `sinceDays` tightens
 * — never widens — the tier window.
 */
async function fetchActivityFeedInput(
  businessId: string,
  limit: number,
  db: SupabaseClient,
  windowDays: number = ACTIVITY_WINDOW_DAYS,
  before?: string,
  filter?: ActivityFilter
): Promise<ActivityFeedInput> {
  const kinds = filter?.kinds ?? [];
  // Empty selection means "everything" — the filter bar treats no chips as all.
  const wants = (...ks: ActivityKind[]): boolean =>
    kinds.length === 0 || ks.some((k) => kinds.includes(k));
  const effectiveDays =
    filter?.sinceDays && filter.sinceDays > 0 ? Math.min(filter.sinceDays, windowDays) : windowDays;
  const since = new Date(Date.now() - effectiveDays * 24 * 60 * 60 * 1000).toISOString();
  // A skipped source resolves to the same shape rowsOf() reads off a query.
  const none = Promise.resolve({ data: [], error: null });
  // Cursor filter, applied per-source on its ordering column. `q` is the
  // PostgREST builder mid-chain; `lt`'s return is typed `any` because a
  // recursive structural constraint (lt(): T) sends tsc into TS2589 against
  // the real builder generics — only the chain shape matters here.
  const beforeLt = <T extends { lt(column: string, value: string): any }>(
    q: T,
    column: string
  ) => (before ? q.lt(column, before) : q);

  // When exactly one email kind is selected, push the direction into the query
  // so the row budget isn't spent on the excluded direction.
  const emailDirection =
    kinds.length === 0 || (kinds.includes("email_inbound") && kinds.includes("email_outbound"))
      ? null
      : kinds.includes("email_inbound")
        ? "inbound"
        : "outbound";

  const [callsRes, smsInRes, smsReplyRes, smsOutRes, emailRes, chatRes, flowsRes, custRes, alertRes] =
    await Promise.all([
      !wants("call")
        ? none
        : beforeLt(
            db
              .from("voice_call_transcripts")
              .select("caller_e164, status, started_at")
              .eq("business_id", businessId)
              .is("deleted_at", null)
              .gte("started_at", since),
            "started_at"
          )
            .order("started_at", { ascending: false })
            .limit(limit),
      !wants("sms_inbound")
        ? none
        : beforeLt(
            db
              .from("sms_inbound_jobs")
              .select("payload, created_at")
              .eq("business_id", businessId)
              .is("deleted_at", null)
              .gte("created_at", since),
            "created_at"
          )
            .order("created_at", { ascending: false })
            .limit(limit),
      // Replies windowed on updated_at (send time) so a recent reply to an
      // older inbound text still appears as outbound activity.
      !wants("sms_outbound")
        ? none
        : beforeLt(
            db
              .from("sms_inbound_jobs")
              .select("payload, updated_at")
              .eq("business_id", businessId)
              .is("deleted_at", null)
              .not("assistant_reply_text", "is", null)
              .gte("updated_at", since),
            "updated_at"
          )
            .order("updated_at", { ascending: false })
            .limit(limit),
      !wants("sms_outbound")
        ? none
        : beforeLt(
            db
              .from("sms_outbound_log")
              .select("to_e164, source, created_at")
              .eq("business_id", businessId)
              .is("deleted_at", null)
              .gte("created_at", since),
            "created_at"
          )
            .order("created_at", { ascending: false })
            .limit(limit),
      // Coworker email activity (AiFlow/assistant sends, trigger emails,
      // tenant-mailbox traffic) — the email counterpart of the SMS sources.
      !wants("email_inbound", "email_outbound")
        ? none
        : beforeLt(
            emailDirection
              ? db
                  .from("email_log")
                  .select("direction, to_email, from_email, subject, source, created_at")
                  .eq("business_id", businessId)
                  .eq("direction", emailDirection)
                  .is("deleted_at", null)
                  .gte("created_at", since)
              : db
                  .from("email_log")
                  .select("direction, to_email, from_email, subject, source, created_at")
                  .eq("business_id", businessId)
                  .is("deleted_at", null)
                  .gte("created_at", since),
            "created_at"
          )
            .order("created_at", { ascending: false })
            .limit(limit),
      !wants("chat")
        ? none
        : beforeLt(
            db
              .from("dashboard_chat_jobs")
              .select("created_at")
              .eq("business_id", businessId)
              .gte("created_at", since),
            "created_at"
          )
            .order("created_at", { ascending: false })
            .limit(limit),
      !wants("aiflow")
        ? none
        : beforeLt(
            db
              .from("ai_flow_runs")
              .select("id, flow_id, status, created_at, ai_flows(name)")
              .eq("business_id", businessId)
              .gte("created_at", since),
            "created_at"
          )
            .order("created_at", { ascending: false })
            .limit(limit),
      !wants("customer")
        ? none
        : beforeLt(
            db
              .from("contacts")
              // Only real customer profiles count as "new customer" activity — folded
              // manual contacts (vendors, services, testers) are not interactions.
              .select("display_name, customer_e164, created_at")
              .eq("business_id", businessId)
              .eq("type", "customer")
              .gte("created_at", since),
            "created_at"
          )
            .order("created_at", { ascending: false })
            .limit(limit),
      // High-signal coworker_logs entries: urgent alerts only. These are the
      // ones dispatched to the notifications page (see evaluateUrgency), so the
      // "/dashboard/notifications" deep link always resolves to the event.
      // `error` rows are intentionally excluded — they aren't dispatched
      // anywhere owner-facing, so there's no page to link them to.
      !wants("alert")
        ? none
        : beforeLt(
            db
              .from("coworker_logs")
              .select("task_type, log_payload, created_at")
              .eq("business_id", businessId)
              .eq("status", "urgent_alert")
              .gte("created_at", since),
            "created_at"
          )
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

  return {
    calls,
    smsInbound,
    smsReplies,
    smsOutbound,
    emails: rowsOf<ActivityEmailRow>(emailRes),
    chat: rowsOf<ActivityChatRow>(chatRes),
    flows: rowsOf<ActivityFlowRow>(flowsRes),
    customers,
    alerts: rowsOf<ActivityAlertRow>(alertRes),
    contactNames,
    limit
  };
}

/**
 * Fetch the most-recent activity across calls, texts, dashboard chat, AiFlow
 * runs, new customers, and urgent alerts for a business, merged into one
 * chronological feed for the dashboard's compact Recent Activity card, capped
 * to `limit`.
 */
export async function getRecentActivity(
  businessId: string,
  limit: number = DEFAULT_ACTIVITY_LIMIT,
  client?: SupabaseClient,
  tier?: string | null
): Promise<ActivityItem[]> {
  const db = client ?? (await createSupabaseServiceClient());
  return buildActivityFeed(
    await fetchActivityFeedInput(businessId, limit, db, activityWindowDays(tier))
  );
}

/**
 * Like {@link getRecentActivity} but for the full "See all activity" page:
 * loads ONE gap-free chunk of up to `limit` items ranked strictly by recency,
 * plus the `nextBefore` cursor for the next-older
 * chunk — so the whole tier window (e.g. 90 days) is reachable, not just the
 * newest {@link ACTIVITY_FEED_MAX} events. Pass `before` (a previous chunk's
 * `nextBefore`) to walk older history. `filter` narrows kinds and the
 * look-back window (see {@link ActivityFilter}).
 */
export async function getActivityFeedPage(
  businessId: string,
  opts: {
    limit?: number;
    before?: string;
    tier?: string | null;
    filter?: ActivityFilter;
  } = {},
  client?: SupabaseClient
): Promise<ActivityFeedPage> {
  const db = client ?? (await createSupabaseServiceClient());
  // A chunk can come back EMPTY while history remains (every row in the
  // boundary window was dropped by the collector, e.g. unparsable SMS
  // payloads). Hop over up to a few such chunks so the owner never lands on a
  // blank page with an "Older activity" link; give up after the bound and
  // return the (empty) page with its cursor intact.
  let before = opts.before;
  let page: ActivityFeedPage = { items: [], nextBefore: null };
  for (let hop = 0; hop < 3; hop++) {
    page = paginateFullActivityFeed(
      await fetchActivityFeedInput(
        businessId,
        opts.limit ?? ACTIVITY_FEED_MAX,
        db,
        activityWindowDays(opts.tier),
        before,
        opts.filter
      )
    );
    if (page.items.length > 0 || !page.nextBefore) return page;
    before = page.nextBefore;
  }
  return page;
}

// ─── Contact-scoped activity ────────────────────────────────────────────────

/** Default item cap for the contact page's Activity card. */
export const DEFAULT_CONTACT_ACTIVITY_LIMIT = 20;

/**
 * How many recent runs to scan when resolving a contact's AiFlow activity.
 * Runs are keyed to a lead only inside their JSON context (see
 * {@link taskLeadPhone}), so we fetch a bounded recent window and filter in
 * process instead of pushing a JSON-path predicate to the database.
 */
export const CONTACT_ACTIVITY_RUN_SCAN = 100;

export type ContactActivityTarget = {
  /** The contact's primary number plus any merged-in aliases. */
  e164s: string[];
  /** Linked email address; adds email_log traffic to the timeline. */
  email?: string | null;
};

/**
 * One person's unified activity timeline: their calls, texts (both
 * directions), email traffic, and the AiFlow runs where they are the lead —
 * newest first, capped at `limit`. This is the contact-page/task-card
 * counterpart of {@link getRecentActivity}: same sources, same item shapes,
 * scoped to one contact's numbers + email instead of the whole business.
 *
 * Chat / new-customer / alert sources are intentionally absent: dashboard
 * chat has no counterpart person, and the profile header already shows the
 * contact's own creation. Failed sources degrade to empty (rowsOf) so one
 * broken table never blanks the card.
 */
export async function getContactActivity(
  businessId: string,
  target: ContactActivityTarget,
  opts: { limit?: number; windowDays?: number } = {},
  client?: SupabaseClient
): Promise<ActivityItem[]> {
  const numbers = [...new Set(target.e164s.filter(Boolean))];
  const email = target.email?.trim() || null;
  if (numbers.length === 0 && !email) return [];

  const db = client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? DEFAULT_CONTACT_ACTIVITY_LIMIT;
  const windowDays = opts.windowDays ?? ACTIVITY_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const none = Promise.resolve({ data: [], error: null });

  const [callsRes, smsInRes, smsReplyRes, smsOutRes, emailRes, flowRes] = await Promise.all([
    numbers.length === 0
      ? none
      : db
          .from("voice_call_transcripts")
          .select("caller_e164, status, started_at")
          .eq("business_id", businessId)
          .in("caller_e164", numbers)
          .is("deleted_at", null)
          .gte("started_at", since)
          .order("started_at", { ascending: false })
          .limit(limit),
    numbers.length === 0
      ? none
      : db
          .from("sms_inbound_jobs")
          .select("payload, created_at")
          .eq("business_id", businessId)
          .in("customer_e164", numbers)
          .is("deleted_at", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit),
    numbers.length === 0
      ? none
      : db
          .from("sms_inbound_jobs")
          .select("payload, updated_at")
          .eq("business_id", businessId)
          .in("customer_e164", numbers)
          .is("deleted_at", null)
          .not("assistant_reply_text", "is", null)
          .gte("updated_at", since)
          .order("updated_at", { ascending: false })
          .limit(limit),
    numbers.length === 0
      ? none
      : db
          .from("sms_outbound_log")
          .select("to_e164, source, created_at")
          .eq("business_id", businessId)
          .in("to_e164", numbers)
          .is("deleted_at", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit),
    // Address values are z.email()-validated on write (no commas/parens), so
    // they are safe inside the PostgREST or() filter string.
    !email
      ? none
      : db
          .from("email_log")
          .select("direction, to_email, from_email, subject, source, created_at")
          .eq("business_id", businessId)
          .is("deleted_at", null)
          .or(`to_email.eq.${email},from_email.eq.${email}`)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(limit),
    numbers.length === 0
      ? none
      : db
          .from("ai_flow_runs")
          .select("id, flow_id, status, context, created_at, ai_flows(name)")
          .eq("business_id", businessId)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(CONTACT_ACTIVITY_RUN_SCAN)
  ]);

  // Keep only the runs whose lead is this contact, stamping the lead number
  // onto the row so the produced items carry contactE164.
  const flows = rowsOf<ActivityFlowRow & { context: Record<string, unknown> | null }>(flowRes)
    .map((r) => ({ ...r, lead_e164: taskLeadPhone(r.context ?? {}) }))
    .filter((r) => r.lead_e164 !== null && numbers.includes(r.lead_e164));

  const contactNames = await resolveContactNames(businessId, numbers, db).catch(
    () => new Map<string, ContactName>()
  );

  const items = collectActivityItems({
    calls: rowsOf<ActivityCallRow>(callsRes),
    smsInbound: rowsOf<ActivitySmsInboundRow>(smsInRes),
    smsReplies: rowsOf<ActivitySmsReplyRow>(smsReplyRes),
    smsOutbound: rowsOf<ActivitySmsOutboundRow>(smsOutRes),
    emails: rowsOf<ActivityEmailRow>(emailRes),
    chat: [],
    flows,
    customers: [],
    alerts: [],
    contactNames,
    limit
  });
  return items.sort(byRecency).slice(0, limit);
}

/**
 * Batched recent activity for MANY contacts at once (the Task Center's
 * per-card timeline): one IN(...) query per source instead of a query
 * fan-out per card. Returns a map keyed by the item's own number — callers
 * with merged profiles fold alias keys into the primary themselves (they
 * hold the alias table; this function deliberately doesn't).
 *
 * Sources are calls + texts only: those are the person-keyed columns that
 * batch cleanly, and they're what a task card needs to answer "what
 * happened with this lead lately?". Email needs a per-contact address and
 * flow runs need context parsing — both stay on the single-contact path
 * ({@link getContactActivity}).
 */
export async function getActivityForContacts(
  businessId: string,
  phones: string[],
  opts: {
    perContact?: number;
    windowDays?: number;
    /** Total rows fetched per source across ALL contacts. */
    scanLimit?: number;
    contactNames?: Map<string, ContactName>;
  } = {},
  client?: SupabaseClient
): Promise<Map<string, ActivityItem[]>> {
  const numbers = [...new Set(phones.filter(Boolean))];
  if (numbers.length === 0) return new Map();

  const db = client ?? (await createSupabaseServiceClient());
  const perContact = opts.perContact ?? 3;
  const windowDays = opts.windowDays ?? ACTIVITY_WINDOW_DAYS;
  const scanLimit = opts.scanLimit ?? 200;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [callsRes, smsInRes, smsReplyRes, smsOutRes] = await Promise.all([
    db
      .from("voice_call_transcripts")
      .select("caller_e164, status, started_at")
      .eq("business_id", businessId)
      .in("caller_e164", numbers)
      .is("deleted_at", null)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(scanLimit),
    db
      .from("sms_inbound_jobs")
      .select("payload, created_at")
      .eq("business_id", businessId)
      .in("customer_e164", numbers)
      .is("deleted_at", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(scanLimit),
    db
      .from("sms_inbound_jobs")
      .select("payload, updated_at")
      .eq("business_id", businessId)
      .in("customer_e164", numbers)
      .is("deleted_at", null)
      .not("assistant_reply_text", "is", null)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(scanLimit),
    db
      .from("sms_outbound_log")
      .select("to_e164, source, created_at")
      .eq("business_id", businessId)
      .in("to_e164", numbers)
      .is("deleted_at", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(scanLimit)
  ]);

  const items = collectActivityItems({
    calls: rowsOf<ActivityCallRow>(callsRes),
    smsInbound: rowsOf<ActivitySmsInboundRow>(smsInRes),
    smsReplies: rowsOf<ActivitySmsReplyRow>(smsReplyRes),
    smsOutbound: rowsOf<ActivitySmsOutboundRow>(smsOutRes),
    emails: [],
    chat: [],
    flows: [],
    customers: [],
    alerts: [],
    contactNames: opts.contactNames,
    limit: scanLimit
  }).sort(byRecency);

  const byContact = new Map<string, ActivityItem[]>();
  for (const item of items) {
    if (!item.contactE164) continue;
    const list = byContact.get(item.contactE164) ?? [];
    if (list.length >= perContact) continue;
    list.push(item);
    byContact.set(item.contactE164, list);
  }
  return byContact;
}
