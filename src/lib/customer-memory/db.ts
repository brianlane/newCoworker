/**
 * Supabase access for customer_memories + the SMS history input feed
 * the summarizer needs.
 *
 * Service-role only: every read/write goes through createSupabaseServiceClient.
 * Owner authorization is the caller's responsibility — these helpers
 * trust the (business_id, customer_e164) pair they're given. API routes
 * MUST call requireOwner() before invoking anything here, exactly like
 * the dashboard chat module.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CustomerMemoryChannel, CustomerMemoryRow } from "./types";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const ALL_COLUMNS =
  "id,business_id,customer_e164,display_name,summary_md,pinned_md," +
  "interaction_count,total_interaction_count,last_interaction_at," +
  "last_summarized_at,last_channel,created_at,updated_at";

export async function getCustomerMemory(
  businessId: string,
  customerE164: string,
  client?: SupabaseClient
): Promise<CustomerMemoryRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("customer_memories")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164)
    .maybeSingle();
  if (error) throw new Error(`getCustomerMemory: ${error.message}`);
  return (data as CustomerMemoryRow | null) ?? null;
}

export type ListCustomerMemoriesOptions = {
  limit?: number;
  /** Filter by display_name OR customer_e164 substring (case-insensitive). */
  search?: string;
};

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export async function listCustomerMemories(
  businessId: string,
  options: ListCustomerMemoriesOptions = {},
  client?: SupabaseClient
): Promise<CustomerMemoryRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT
  );
  let query = db
    .from("customer_memories")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  const search = options.search?.trim();
  if (search) {
    // PostgREST `.or()` parses commas as condition separators and dots
    // as field/operator/value delimiters inside the filter string,
    // so a search like `"Smith, LLC"` or `"127.0"` would split into
    // multiple malformed conditions and either error or silently
    // match the wrong rows (Cursor Bugbot Medium on PR #74).
    //
    // Per PostgREST docs, values containing reserved chars must be
    // wrapped in DOUBLE QUOTES inside the filter string, with any
    // embedded double quotes escaped via backslash. We layer that on
    // top of the existing SQL `LIKE` wildcard escape so a search of
    // `100%` matches the literal `100%`, not "anything starting with
    // 100".
    //
    // BOTH `"` AND `\` must be backslash-escaped for the PostgREST
    // double-quoted value syntax. PostgREST collapses any `\<char>`
    // sequence inside double-quoted values to `<char>` BEFORE the
    // value reaches Postgres LIKE, so the single backslash that step 1
    // injects in front of `%` / `_` would otherwise be eaten by
    // PostgREST and never reach LIKE — turning a search for `100%`
    // back into a wildcard match. Doubling the backslash here means
    // PostgREST collapses `\\` → `\` and LIKE receives the escape it
    // needs (verified end-to-end against the live REST surface; an
    // earlier "only escape quote" fix regressed `100%` to also match
    // `100abc`, see commit history). CodeQL flags this as
    // "incomplete-string-escaping" precisely because BOTH chars need
    // covering — we keep the `["\\]` class deliberately.
    const escapedForLike = search.replace(/[%_]/g, (m) => `\\${m}`);
    const escapedForPostgrest = escapedForLike.replace(/["\\]/g, "\\$&");
    const pattern = `"%${escapedForPostgrest}%"`;
    // Match either the display name or the raw E.164 — owners often
    // remember "Joe" but not the +1555… number, and vice versa.
    query = query.or(`display_name.ilike.${pattern},customer_e164.ilike.${pattern}`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listCustomerMemories: ${error.message}`);
  // `.or()` widens the query result type to include
  // `GenericStringError`, so go through unknown to apply the row
  // shape we control via the explicit ALL_COLUMNS select.
  return (data ?? []) as unknown as CustomerMemoryRow[];
}

/**
 * Atomically: ensure a customer_memories row exists for
 * (businessId, customerE164), bump both counters, set the timestamp
 * + channel. Returns the post-update row so the caller can branch on
 * `interaction_count >= 3` without a separate read.
 *
 * Why a single query: this runs on the hot inbound path (every SMS,
 * every voice call). Two round-trips (insert-then-update) would add
 * ~150-300ms RTT on a slow Supabase day, doubled for the cross-region
 * Vercel→Supabase hop.
 */
export async function recordInteractionAndIncrement(
  businessId: string,
  customerE164: string,
  channel: CustomerMemoryChannel,
  options: { displayName?: string | null } = {},
  client?: SupabaseClient
): Promise<CustomerMemoryRow> {
  const db = client ?? (await createSupabaseServiceClient());
  // Single-statement upsert: insert with counters at 1 OR collide and
  // run the UPDATE branch which increments. Postgres `excluded.*`
  // refers to the row we tried to insert; the persisted columns are
  // already in the target row.
  const { data, error } = await db.rpc("record_customer_interaction", {
    p_business_id: businessId,
    p_customer_e164: customerE164,
    p_channel: channel,
    p_display_name: options.displayName ?? null
  });
  if (error) throw new Error(`recordInteractionAndIncrement: ${error.message}`);
  const row = (data as CustomerMemoryRow[] | CustomerMemoryRow | null) ?? null;
  if (!row) {
    throw new Error("recordInteractionAndIncrement: rpc returned no row");
  }
  return Array.isArray(row) ? row[0] : row;
}

export type UpdateSummaryInput = {
  summaryMd: string;
  /** Reset interaction_count to 0 — required when the summary just absorbed everything. */
  resetCounter: true;
};

export async function updateCustomerSummary(
  businessId: string,
  customerE164: string,
  input: UpdateSummaryInput,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("customer_memories")
    .update({
      summary_md: input.summaryMd,
      interaction_count: 0,
      last_summarized_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164);
  if (error) throw new Error(`updateCustomerSummary: ${error.message}`);
}

export type CustomerOwnerEdit = {
  displayName?: string | null;
  pinnedMd?: string | null;
};

/** Owner-driven edit (customers page). Only writes the fields the owner controls. */
export async function updateCustomerOwnerFields(
  businessId: string,
  customerE164: string,
  edit: CustomerOwnerEdit,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...("displayName" in edit ? { display_name: edit.displayName } : {}),
    ...("pinnedMd" in edit ? { pinned_md: edit.pinnedMd } : {})
  };
  const { error } = await db
    .from("customer_memories")
    .update(patch)
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164);
  if (error) throw new Error(`updateCustomerOwnerFields: ${error.message}`);
}

export async function deleteCustomerMemory(
  businessId: string,
  customerE164: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("customer_memories")
    .delete()
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164);
  if (error) throw new Error(`deleteCustomerMemory: ${error.message}`);
}

/**
 * Recent SMS turns for this customer, oldest first. Each row is one
 * inbound message (`sms_inbound_jobs`) plus the assistant reply that
 * Rowboat produced for it. Used by the summarizer (Phase 2) AND the
 * customers page conversation viewer (Phase 4).
 */
export type SmsHistoryEntry = {
  jobId: string;
  inboundText: string;
  assistantReply: string | null;
  receivedAt: string;
};

const DEFAULT_SMS_HISTORY_LIMIT = 30;

export async function listSmsHistoryForCustomer(
  businessId: string,
  customerE164: string,
  options: { limit?: number } = {},
  client?: SupabaseClient
): Promise<SmsHistoryEntry[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_SMS_HISTORY_LIMIT),
    100
  );
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select("id, payload, assistant_reply_text, rowboat_reply_cached, created_at")
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSmsHistoryForCustomer: ${error.message}`);
  // Returned newest-first by the planner (cheaper to LIMIT against
  // the desc index); flip to chronological so the summarizer prompt
  // reads in conversation order.
  const rows = ((data as Array<{
    id: string;
    payload: Record<string, unknown>;
    assistant_reply_text: string | null;
    rowboat_reply_cached: string | null;
    created_at: string;
  }> | null) ?? []).slice().reverse();
  // Prefer the durable `assistant_reply_text` (never cleared); fall back to the
  // transient `rowboat_reply_cached` for legacy rows whose reply was already
  // wiped after a successful send.
  const resolveReply = (durable: string | null, cached: string | null): string | null => {
    if (typeof durable === "string" && durable.trim().length > 0) return durable;
    if (typeof cached === "string" && cached.trim().length > 0) return cached;
    return null;
  };
  return rows.map((r) => ({
    jobId: r.id,
    inboundText: extractInboundText(r.payload),
    assistantReply: resolveReply(r.assistant_reply_text, r.rowboat_reply_cached),
    receivedAt: r.created_at
  }));
}

function extractInboundText(payload: Record<string, unknown>): string {
  // Telnyx envelope: { data: { payload: { text | body: string, ... } } }.
  // Tolerant of both keys (different Telnyx API versions over time).
  const data = (payload as { data?: { payload?: Record<string, unknown> } }).data;
  const inner = data?.payload ?? {};
  const t = inner["text"];
  if (typeof t === "string") return t;
  const b = inner["body"];
  if (typeof b === "string") return b;
  return "";
}
