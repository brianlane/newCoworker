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
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SmsJobRow = {
  id: string;
  business_id: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "done" | "dead_letter";
  rowboat_reply_cached: string | null;
  telnyx_outbound_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

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
  return "";
}

/**
 * Pluck the customer-side phone (E.164) from a Telnyx webhook envelope.
 * Returns `null` when the envelope shape is unrecognized — the caller
 * should drop those rows from the conversation index rather than crash.
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
  if (typeof from === "string" && from.startsWith("+")) return from;
  if (
    from &&
    typeof from === "object" &&
    typeof from.phone_number === "string" &&
    from.phone_number.startsWith("+")
  ) {
    return from.phone_number;
  }
  return null;
}

/**
 * Group the most-recent N inbound jobs into per-customer conversations.
 * Sorted by most-recent activity first. Rows without a parseable customer
 * number are skipped (typically Telnyx delivery receipts that landed in
 * the wrong table — defence against schema drift).
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
    .select(
      "id, business_id, payload, status, rowboat_reply_cached, telnyx_outbound_message_id, last_error, created_at, updated_at"
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit * 4, MAX_LIST_LIMIT * 4));
  if (error) {
    throw new Error(`listConversationsForBusiness: ${error.message}`);
  }
  const rows = (data as SmsJobRow[] | null) ?? [];
  const byCustomer = new Map<string, SmsConversation>();
  for (const row of rows) {
    const cust = customerE164FromPayload(row.payload);
    if (!cust) continue;
    const inboundText = inboundTextFromPayload(row.payload);
    const preview = inboundText || row.rowboat_reply_cached || "(no text)";
    const existing = byCustomer.get(cust);
    if (!existing) {
      byCustomer.set(cust, {
        customerE164: cust,
        lastMessageAt: row.created_at,
        lastMessage: preview,
        lastStatus: row.status,
        messageCount: 1
      });
    } else {
      existing.messageCount += 1;
    }
  }
  return Array.from(byCustomer.values())
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * List every message exchanged with `customerE164`, expanded to one
 * record per direction. Inbound first, then outbound (when reply exists),
 * sorted oldest → newest so the UI can render the thread top-down.
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
    .select(
      "id, business_id, payload, status, rowboat_reply_cached, telnyx_outbound_message_id, last_error, created_at, updated_at"
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit * 4, MAX_LIST_LIMIT * 4));
  if (error) {
    throw new Error(`listMessagesForCustomer: ${error.message}`);
  }
  const rows = (data as SmsJobRow[] | null) ?? [];
  // Reverse to chronological order BEFORE expansion so the inbound/
  // outbound pairs land in the messages array in the correct order
  // (inbound at index N, outbound at N+1).
  const chronological = rows.slice().reverse();
  const messages: SmsMessage[] = [];
  for (const row of chronological) {
    const cust = customerE164FromPayload(row.payload);
    if (cust !== customerE164) continue;
    const inboundText = inboundTextFromPayload(row.payload);
    if (inboundText) {
      messages.push({
        id: `${row.id}:inbound`,
        jobId: row.id,
        direction: "inbound",
        content: inboundText,
        timestamp: row.created_at,
        status: row.status,
        lastError: null
      });
    }
    if (row.rowboat_reply_cached) {
      messages.push({
        id: `${row.id}:outbound`,
        jobId: row.id,
        direction: "outbound",
        content: row.rowboat_reply_cached,
        // Outbound timestamp tracks when the worker finished — falls back
        // to created_at on legacy rows that pre-date the updated_at stamp.
        timestamp: row.updated_at || row.created_at,
        status: row.status,
        lastError: row.last_error
      });
    }
  }
  // Keep the most recent `limit` expanded messages (slice from the END
  // of the chronological array) so we never drop a reply paired with the
  // row that hit the SQL limit.
  return messages.slice(-limit);
}

function clampLimit(raw: number | undefined): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(n, MAX_LIST_LIMIT));
}
