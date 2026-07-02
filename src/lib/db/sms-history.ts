/**
 * SMS conversation reads for the owner dashboard.
 *
 * Writes happen from the Telnyx inbound Edge function and the SMS worker
 * (`sms-inbound-worker`); this module is read-only and exists to keep
 * `requireOwner()`-gated API routes thin. Every helper scopes by
 * `business_id` so one business can never read another's threads.
 *
 * Storage model:
 *   `sms_inbound_jobs` is the canonical SMS log. Each row stores:
 *     - the inbound Telnyx envelope under `payload`
 *       (`payload.data.payload` carries from/to/text)
 *     - the assistant reply under `rowboat_reply_cached`
 *     - lifecycle bookkeeping (`status`, `last_error`, `attempt_count`,
 *       outbound message id when delivery succeeded)
 *
 *   We synthesize "messages" from each row: 1 inbound + 1 outbound when a
 *   reply was generated. There is no separate `sms_messages` table; the
 *   inbound job IS the conversational unit.
 *
 *   `sms_outbound_log` holds worker-initiated sends (AiFlow lead intros,
 *   team agent offers, owner notifications) that have no inbound job — the
 *   ai-flow-worker writes one row per send. Both sources are merged here so
 *   the Text history shows every message the coworker sent, not just replies
 *   to inbound texts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SmsJobRow = {
  id: string;
  business_id: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "done" | "dead_letter";
  /**
   * Durable outbound reply text. Written by the worker at send time and never
   * cleared — the canonical source for the dashboard thread.
   */
  assistant_reply_text: string | null;
  /**
   * Transient Telnyx-retry buffer. Nulled after a successful send, so it only
   * carries text for in-flight / failed jobs. Used as a fallback for legacy
   * rows that pre-date `assistant_reply_text`.
   */
  rowboat_reply_cached: string | null;
  telnyx_outbound_message_id: string | null;
  last_error: string | null;
  /** Channel the inbound arrived on ('sms' default; 'rcs' for RCS webhooks). */
  channel?: "sms" | "rcs" | null;
  created_at: string;
  updated_at: string;
};

/**
 * The assistant's outbound reply for a job. Prefer the durable
 * `assistant_reply_text`; fall back to the transient `rowboat_reply_cached`
 * for legacy rows (or jobs still mid-flight before the durable copy existed).
 */
export function outboundReplyFromRow(
  row: Pick<SmsJobRow, "assistant_reply_text" | "rowboat_reply_cached">
): string | null {
  const durable = row.assistant_reply_text;
  if (typeof durable === "string" && durable.trim().length > 0) return durable;
  const cached = row.rowboat_reply_cached;
  if (typeof cached === "string" && cached.trim().length > 0) return cached;
  return null;
}

const SMS_JOB_SELECT =
  "id, business_id, payload, status, assistant_reply_text, rowboat_reply_cached, telnyx_outbound_message_id, last_error, channel, created_at, updated_at";

export type OutboundLogSource = "ai_flow" | "agent_offer" | "owner_notify" | "owner_manual";

export type OutboundLogRow = {
  id: string;
  business_id: string;
  to_e164: string;
  from_e164: string | null;
  body: string;
  source: OutboundLogSource;
  run_id: string | null;
  flow_id: string | null;
  telnyx_message_id: string | null;
  /** Channel the send was attempted on ('sms' default; 'rcs' = RCS-first). */
  channel?: "sms" | "rcs" | null;
  created_at: string;
};

const OUTBOUND_LOG_SELECT =
  "id, business_id, to_e164, from_e164, body, source, run_id, flow_id, telnyx_message_id, channel, created_at";

export type SmsMessageDirection = "inbound" | "outbound";

export type SmsMessage = {
  /** Synthetic id — `<job_id>:<direction>` so React lists are stable. */
  id: string;
  jobId: string;
  direction: SmsMessageDirection;
  content: string;
  /** ISO timestamp; for inbound we use job.created_at, for outbound job.updated_at. */
  timestamp: string;
  status: SmsJobRow["status"];
  lastError: string | null;
  /** Set for worker-initiated sends from `sms_outbound_log` (AiFlow etc.). */
  source?: OutboundLogSource;
  /** Delivery channel; 'rcs' renders a channel badge in the thread UI. */
  channel?: "sms" | "rcs";
};

export type SmsConversation = {
  customerE164: string;
  lastMessageAt: string;
  /** Preview text — last inbound message, or last outbound if no inbound text recoverable. */
  lastMessage: string;
  /** Whether the most recent exchange ended in `done`. */
  lastStatus: SmsJobRow["status"];
  messageCount: number;
};

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/**
 * Pluck the inbound text from a Telnyx webhook envelope.
 *
 * Defensive against:
 *   - missing `data` / `payload`
 *   - alternate spellings (`text` vs `body` — Telnyx is inconsistent)
 *   - non-string payloads
 */
export function inboundTextFromPayload(
  payload: Record<string, unknown> | null | undefined
): string {
  if (!payload || typeof payload !== "object") return "";
  const data = (payload as { data?: { payload?: Record<string, unknown> } }).data;
  const inner = data?.payload ?? {};
  const text = inner["text"];
  if (typeof text === "string") return text;
  const body = inner["body"];
  if (typeof body === "string") return body;
  // RCS inbound nests content under a body OBJECT: `body.text` for typed
  // messages, `body.suggestion_response.text` for tapped suggested replies.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (typeof b["text"] === "string") return b["text"];
    const suggestion = b["suggestion_response"];
    if (suggestion && typeof suggestion === "object") {
      const st = (suggestion as Record<string, unknown>)["text"];
      if (typeof st === "string") return st;
    }
  }
  return "";
}

/**
 * A renderable sender id: E.164, or a bare 3-8 digit SHORT CODE. Lead
 * sources text from short codes (ReferralExchange = 73339); rejecting them
 * made those threads invisible in Text history even though the jobs exist.
 */
function isRenderableSender(value: string): boolean {
  return value.startsWith("+") || /^\d{3,8}$/.test(value);
}

/**
 * Pluck the customer-side phone (E.164 or short code) from a Telnyx webhook
 * envelope. Returns `null` when the envelope shape is unrecognized — the
 * caller should drop those rows from the conversation index rather than
 * crash.
 */
export function customerE164FromPayload(
  payload: Record<string, unknown> | null | undefined
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: { payload?: Record<string, unknown> } }).data;
  const inner = data?.payload;
  if (!inner) return null;
  const from = inner["from"] as
    | { phone_number?: string }
    | string
    | undefined;
  if (typeof from === "string" && isRenderableSender(from)) return from;
  if (
    from &&
    typeof from === "object" &&
    typeof from.phone_number === "string" &&
    isRenderableSender(from.phone_number)
  ) {
    return from.phone_number;
  }
  return null;
}

/**
 * Group the most-recent N inbound jobs PLUS worker-initiated outbound sends
 * into per-customer conversations. Sorted by most-recent activity first.
 * Rows without a parseable customer number are skipped (typically Telnyx
 * delivery receipts that landed in the wrong table — defence against schema
 * drift).
 */
export async function listConversationsForBusiness(
  businessId: string,
  options: { limit?: number } = {},
  client?: SupabaseClient
): Promise<SmsConversation[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = clampLimit(options.limit);
  // Pull a generous window so a single customer with N inbound bursts
  // doesn't push other customers off the page. We over-fetch up to 4x
  // the requested conversation count and dedupe in JS.
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select(SMS_JOB_SELECT)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit * 4, MAX_LIST_LIMIT * 4));
  if (error) {
    throw new Error(`listConversationsForBusiness: ${error.message}`);
  }
  const { data: outboundData, error: outboundError } = await db
    .from("sms_outbound_log")
    .select(OUTBOUND_LOG_SELECT)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit * 4, MAX_LIST_LIMIT * 4));
  if (outboundError) {
    throw new Error(`listConversationsForBusiness: ${outboundError.message}`);
  }
  const rows = (data as SmsJobRow[] | null) ?? [];
  const outboundRows = (outboundData as OutboundLogRow[] | null) ?? [];
  const byCustomer = new Map<string, SmsConversation>();
  for (const row of rows) {
    const cust = customerE164FromPayload(row.payload);
    if (!cust) continue;
    const inboundText = inboundTextFromPayload(row.payload);
    const outboundText = outboundReplyFromRow(row);
    const preview = inboundText || outboundText || "(no text)";
    // Count EXPANDED messages (matching listMessagesForCustomer), so the
    // "5 msgs" pill on the index page agrees with the message count the
    // user sees inside the thread. Bugbot caught this mismatch on PR #69:
    // a job with both inbound text + outbound reply expands to TWO
    // messages, not one. See discussion_r3192...82.
    const expandedThisRow =
      (inboundText ? 1 : 0) + (outboundText ? 1 : 0);
    if (expandedThisRow === 0) {
      // Defensive: if neither side parsed, still count one row so the
      // conversation doesn't accidentally get pruned to zero.
      const existing0 = byCustomer.get(cust);
      if (!existing0) {
        byCustomer.set(cust, {
          customerE164: cust,
          lastMessageAt: row.created_at,
          lastMessage: preview,
          lastStatus: row.status,
          messageCount: 1
        });
      } else {
        existing0.messageCount += 1;
      }
      continue;
    }
    const existing = byCustomer.get(cust);
    if (!existing) {
      byCustomer.set(cust, {
        customerE164: cust,
        lastMessageAt: row.created_at,
        lastMessage: preview,
        lastStatus: row.status,
        messageCount: expandedThisRow
      });
    } else {
      existing.messageCount += expandedThisRow;
    }
  }
  // Fold worker-initiated sends in: each log row is one outbound message.
  // Unlike the inbound loop above (which relies on newest-first iteration to
  // set the preview), these may interleave with inbound rows in time, so the
  // preview/timestamp only advance when the log row is strictly newer.
  for (const row of outboundRows) {
    const existing = byCustomer.get(row.to_e164);
    if (!existing) {
      byCustomer.set(row.to_e164, {
        customerE164: row.to_e164,
        lastMessageAt: row.created_at,
        lastMessage: row.body,
        lastStatus: "done",
        messageCount: 1
      });
      continue;
    }
    existing.messageCount += 1;
    if (row.created_at > existing.lastMessageAt) {
      existing.lastMessageAt = row.created_at;
      existing.lastMessage = row.body;
      existing.lastStatus = "done";
    }
  }
  return Array.from(byCustomer.values())
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * List every message exchanged with `customerE164`, expanded to one
 * record per direction. Inbound first, then outbound (when reply exists),
 * merged with worker-initiated sends from `sms_outbound_log`, sorted
 * oldest → newest so the UI can render the thread top-down.
 */
export async function listMessagesForCustomer(
  businessId: string,
  customerE164: string,
  options: { limit?: number } = {},
  client?: SupabaseClient
): Promise<SmsMessage[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = clampLimit(options.limit);
  // We can't filter by customer in SQL without a JSON path index, so we
  // over-fetch the MOST-RECENT rows for the business (`ascending: false`)
  // and then post-filter in JS. Sorting ascending here would pull the
  // OLDEST 200 rows once a business crosses the limit threshold, hiding
  // every recent message from the thread. Bugbot caught this: see PR #69
  // discussion_r3192089896. Mirror the conversation index helper which
  // also uses `ascending: false` for the same reason.
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select(SMS_JOB_SELECT)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit * 4, MAX_LIST_LIMIT * 4));
  if (error) {
    throw new Error(`listMessagesForCustomer: ${error.message}`);
  }
  // Worker-initiated sends CAN be filtered in SQL (to_e164 is a real column).
  const { data: outboundData, error: outboundError } = await db
    .from("sms_outbound_log")
    .select(OUTBOUND_LOG_SELECT)
    .eq("business_id", businessId)
    .eq("to_e164", customerE164)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, MAX_LIST_LIMIT));
  if (outboundError) {
    throw new Error(`listMessagesForCustomer: ${outboundError.message}`);
  }
  const rows = (data as SmsJobRow[] | null) ?? [];
  const outboundRows = (outboundData as OutboundLogRow[] | null) ?? [];
  // Reverse to chronological order BEFORE expansion so the inbound/
  // outbound pairs land in the messages array in the correct order
  // (inbound at index N, outbound at N+1).
  const chronological = rows.slice().reverse();
  const messages: SmsMessage[] = [];
  for (const row of chronological) {
    const cust = customerE164FromPayload(row.payload);
    if (cust !== customerE164) continue;
    const inboundText = inboundTextFromPayload(row.payload);
    const rowChannel = row.channel === "rcs" ? "rcs" : "sms";
    if (inboundText) {
      messages.push({
        id: `${row.id}:inbound`,
        jobId: row.id,
        direction: "inbound",
        content: inboundText,
        timestamp: row.created_at,
        status: row.status,
        lastError: null,
        channel: rowChannel
      });
    }
    const outboundText = outboundReplyFromRow(row);
    if (outboundText) {
      messages.push({
        id: `${row.id}:outbound`,
        jobId: row.id,
        direction: "outbound",
        content: outboundText,
        // Outbound timestamp tracks when the worker finished — falls back
        // to created_at on legacy rows that pre-date the updated_at stamp.
        timestamp: row.updated_at || row.created_at,
        status: row.status,
        lastError: row.last_error,
        channel: rowChannel
      });
    }
  }
  for (const row of outboundRows) {
    messages.push({
      id: `${row.id}:flow-outbound`,
      jobId: row.id,
      direction: "outbound",
      content: row.body,
      timestamp: row.created_at,
      status: "done",
      lastError: null,
      source: row.source,
      channel: row.channel === "rcs" ? "rcs" : "sms"
    });
  }
  // Worker sends interleave with the conversation in time, so re-sort the
  // merged list chronologically. The expansion above pushes an inbound/
  // outbound pair with identical-or-increasing timestamps, so a stable sort
  // preserves their order.
  messages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  // Keep the most recent `limit` expanded messages (slice from the END
  // of the chronological array) so we never drop a reply paired with the
  // row that hit the SQL limit.
  return messages.slice(-limit);
}

function clampLimit(raw: number | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(n, MAX_LIST_LIMIT));
}
