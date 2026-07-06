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
import type {
  ContactNameSource,
  ContactType,
  CustomerMemoryChannel,
  CustomerMemoryRow,
  SmsReplyMode
} from "./types";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const ALL_COLUMNS =
  "id,business_id,customer_e164,type,name_source,sms_reply_mode,display_name,email,summary_md,pinned_md," +
  "interaction_count,total_interaction_count,last_interaction_at," +
  "last_summarized_at,last_channel,alias_e164s,created_at,updated_at";

export async function getCustomerMemory(
  businessId: string,
  customerE164: string,
  client?: SupabaseClient
): Promise<CustomerMemoryRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  // Match the primary number OR any merged-away alias so a profile keeps
  // resolving from its old number after merge_customer_memories(). E.164 is
  // strictly `+digits`, so the value is safe inside the PostgREST filter
  // string (no commas/dots/braces to escape). `cs` = array contains, served
  // by the GIN index on alias_e164s.
  const { data, error } = await db
    .from("contacts")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .or(`customer_e164.eq.${customerE164},alias_e164s.cs.{${customerE164}}`)
    .maybeSingle();
  if (error) throw new Error(`getCustomerMemory: ${error.message}`);
  return (data as CustomerMemoryRow | null) ?? null;
}

export type CreateCustomerInput = {
  customerE164: string;
  displayName?: string | null;
  pinnedMd?: string | null;
  email?: string | null;
  /** Contact classification; defaults to 'customer' (the DB default) when omitted. */
  type?: ContactType;
};

/** Postgres unique-violation SQLSTATE — a profile already exists for this number. */
export const PG_UNIQUE_VIOLATION = "23505";

export class CustomerExistsError extends Error {
  constructor(public readonly customerE164: string) {
    super(`A customer profile already exists for ${customerE164}`);
    this.name = "CustomerExistsError";
  }
}

/**
 * Owner-driven manual customer creation (customers page "Add customer").
 * Unlike recordInteractionAndIncrement this does NOT fake an interaction —
 * counters start at 0 and last_channel stays null until the customer actually
 * texts/calls. Throws CustomerExistsError when a profile already exists for the
 * (business, number) pair so the caller can surface a friendly 409.
 */
export async function createCustomerMemory(
  businessId: string,
  input: CreateCustomerInput,
  client?: SupabaseClient
): Promise<CustomerMemoryRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const trimmedName = input.displayName?.trim() || null;
  const { data, error } = await db
    .from("contacts")
    .insert({
      business_id: businessId,
      customer_e164: input.customerE164,
      display_name: trimmedName,
      // Owner-driven "Add customer": a name typed here is a deliberate label, so
      // it wins over the read-time owner/employee overlay (name_source='manual').
      // A nameless add stays 'auto' (the DB default) — nothing to protect yet.
      ...(trimmedName ? { name_source: "manual" satisfies ContactNameSource } : {}),
      email: input.email?.trim() || null,
      pinned_md: input.pinnedMd?.trim() || null,
      ...(input.type ? { type: input.type } : {})
    })
    .select(ALL_COLUMNS)
    .single();
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw new CustomerExistsError(input.customerE164);
    }
    throw new Error(`createCustomerMemory: ${error.message}`);
  }
  return data as unknown as CustomerMemoryRow;
}

/**
 * Owner-driven profile merge: folds `fromE164` into `intoE164` (concatenated
 * summary/pinned, summed counters, alias recorded) and deletes the from-row.
 * All field semantics live in the merge_customer_memories RPC.
 */
export async function mergeCustomerMemories(
  businessId: string,
  fromE164: string,
  intoE164: string,
  client?: SupabaseClient
): Promise<CustomerMemoryRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("merge_customer_memories", {
    p_business_id: businessId,
    p_from_e164: fromE164,
    p_into_e164: intoE164
  });
  if (error) throw new Error(`mergeCustomerMemories: ${error.message}`);
  const row = (data as CustomerMemoryRow[] | CustomerMemoryRow | null) ?? null;
  if (!row) throw new Error("mergeCustomerMemories: rpc returned no row");
  return Array.isArray(row) ? row[0] : row;
}

/**
 * Find a customer profile by its linked email (case-insensitive), scoped to
 * the business. Powers inbound-email recognition: when mail arrives from an
 * address an owner has linked to a customer, we roll it up to that profile.
 * Returns the minimal identity the caller needs; null when no profile matches.
 */
export async function findCustomerByEmail(
  businessId: string,
  email: string,
  client?: SupabaseClient
): Promise<{ customerE164: string; displayName: string | null } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const db = client ?? (await createSupabaseServiceClient());
  // Escape LIKE metacharacters so a local-part like `joe_smith` can't match
  // `joeXsmith`; then re-verify exact (case-insensitive) equality in JS so the
  // result is never a wildcard false positive.
  const pattern = normalized.replace(/[%_\\]/g, (m) => `\\${m}`);
  const { data, error } = await db
    .from("contacts")
    .select("customer_e164, display_name, email")
    .eq("business_id", businessId)
    .ilike("email", pattern)
    // Deterministic tie-break: if two profiles share an address (no per-business
    // uniqueness on email), always resolve to the same one rather than letting
    // PostgREST return rows in an arbitrary order.
    .order("customer_e164", { ascending: true })
    .limit(5);
  if (error) throw new Error(`findCustomerByEmail: ${error.message}`);
  const row = ((data as Array<{
    customer_e164: string;
    display_name: string | null;
    email: string | null;
  }> | null) ?? []).find((r) => (r.email ?? "").trim().toLowerCase() === normalized);
  if (!row) return null;
  return { customerE164: row.customer_e164, displayName: row.display_name };
}

/**
 * Best-effort: attach an email to a customer's cross-channel profile so future
 * inbound mail from that address rolls up to the same contact (and the
 * summarizer can fold the correspondence in). Used when a caller/texter shares
 * their email with the assistant.
 *
 * Precedence: never clobber an address the OWNER already set on the profile.
 * We only fill an empty `email`; if the row already has one (owner edit, lead
 * backfill, an earlier capture), we leave it untouched. Creates a minimal
 * profile when none exists yet — counters/last_channel stay at their defaults
 * (the inbound recorder owns those), so this can't fake an interaction.
 */
export async function linkCustomerEmail(
  businessId: string,
  customerE164: string,
  email: string,
  client?: SupabaseClient
): Promise<void> {
  const normalized = email.trim();
  if (!normalized) return;
  const db = client ?? (await createSupabaseServiceClient());
  // 1) Resolve the contact ALIAS-AWARE: after a profile merge the caller's
  //    number lives in `alias_e164s` on the surviving row, not as
  //    `customer_e164`. Matching only the raw number would miss that row and
  //    (below) insert a duplicate profile, splitting voice/SMS identity from
  //    the email rollup. Mirror getCustomerMemory's (e164 OR alias) filter.
  const { data: existing, error: selErr } = await db
    .from("contacts")
    .select("id, email")
    .eq("business_id", businessId)
    .or(`customer_e164.eq.${customerE164},alias_e164s.cs.{${customerE164}}`)
    .maybeSingle();
  if (selErr) throw new Error(`linkCustomerEmail: ${selErr.message}`);
  if (existing) {
    // Never clobber an address the OWNER (or an earlier capture) already set.
    if (existing.email) return;
    const { error: updErr } = await db
      .from("contacts")
      .update({ email: normalized, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (updErr) throw new Error(`linkCustomerEmail: ${updErr.message}`);
    return;
  }
  // 2) No profile exists yet for this number. Insert a minimal one.
  const { error: insErr } = await db.from("contacts").insert({
    business_id: businessId,
    customer_e164: customerE164,
    email: normalized
  });
  if (!insErr) return;
  if (insErr.code !== PG_UNIQUE_VIOLATION) {
    throw new Error(`linkCustomerEmail: ${insErr.message}`);
  }
  // Unique violation: a concurrent writer (e.g. record_customer_interaction)
  // created the profile between our SELECT and INSERT — almost certainly with
  // a null email. Don't drop the captured address: fill it now, alias-aware,
  // but only while still empty so we never clobber an owner-set value.
  const { error: raceErr } = await db
    .from("contacts")
    .update({ email: normalized, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .or(`customer_e164.eq.${customerE164},alias_e164s.cs.{${customerE164}}`)
    .is("email", null);
  if (raceErr) throw new Error(`linkCustomerEmail: ${raceErr.message}`);
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
    .from("contacts")
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
    .from("contacts")
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

/**
 * Stamp last_summarized_at WITHOUT writing a summary or resetting the
 * interaction counter. Used when the summarizer looked and decided there is
 * nothing to summarize (e.g. no customer-authored content yet) — the stamp
 * rotates the contact to the back of the nightly sweep's oldest-first queue
 * so permanent skips can't starve other contacts of their sweep slot.
 */
export async function touchLastSummarizedAt(
  businessId: string,
  customerE164: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("contacts")
    .update({
      last_summarized_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164);
  if (error) throw new Error(`touchLastSummarizedAt: ${error.message}`);
}

export type CustomerOwnerEdit = {
  displayName?: string | null;
  pinnedMd?: string | null;
  email?: string | null;
  /** Re-classify the contact (customer/tester/service/other/...). */
  type?: ContactType;
  /** Default-reply behavior for this contact's inbound SMS. */
  smsReplyMode?: SmsReplyMode;
  /**
   * Provenance to stamp on display_name. The dashboard owner-edit passes
   * 'manual' (the name should stick over the owner/employee overlay); the
   * agent-discovered path (setCustomerDisplayName) omits it so the captured
   * name stays 'auto'. Only meaningful alongside `displayName`.
   */
  nameSource?: ContactNameSource;
};

/** Owner-driven edit (contacts page). Only writes the fields the owner controls. */
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
    ...("nameSource" in edit && edit.nameSource ? { name_source: edit.nameSource } : {}),
    ...("pinnedMd" in edit ? { pinned_md: edit.pinnedMd } : {}),
    ...("email" in edit ? { email: edit.email } : {}),
    ...("type" in edit && edit.type ? { type: edit.type } : {}),
    ...("smsReplyMode" in edit && edit.smsReplyMode
      ? { sms_reply_mode: edit.smsReplyMode }
      : {})
  };
  const { error } = await db
    .from("contacts")
    .update(patch)
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164);
  if (error) throw new Error(`updateCustomerOwnerFields: ${error.message}`);
}

/**
 * Set a contact's SMS reply mode, creating a minimal contact row when none
 * exists yet. The SMS-thread page offers the toggle for any number with
 * message history — including senders that never got an auto-created profile
 * (e.g. AiFlow-suppressed lead sources) — so this must not 404 on a missing
 * row. Alias-aware on the update path, mirroring getCustomerMemory.
 */
export async function setContactSmsReplyMode(
  businessId: string,
  customerE164: string,
  mode: SmsReplyMode,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: updated, error: updErr } = await db
    .from("contacts")
    .update({ sms_reply_mode: mode, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .or(`customer_e164.eq.${customerE164},alias_e164s.cs.{${customerE164}}`)
    .select("id");
  if (updErr) throw new Error(`setContactSmsReplyMode: ${updErr.message}`);
  if ((updated ?? []).length > 0) return;
  const { error: insErr } = await db.from("contacts").insert({
    business_id: businessId,
    customer_e164: customerE164,
    sms_reply_mode: mode
  });
  if (insErr && insErr.code !== PG_UNIQUE_VIOLATION) {
    throw new Error(`setContactSmsReplyMode: ${insErr.message}`);
  }
  if (insErr) {
    // Raced by a concurrent profile create — apply the mode to the winner.
    const { error: raceErr } = await db
      .from("contacts")
      .update({ sms_reply_mode: mode, updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${customerE164},alias_e164s.cs.{${customerE164}}`);
    if (raceErr) throw new Error(`setContactSmsReplyMode: ${raceErr.message}`);
  }
}

export async function deleteCustomerMemory(
  businessId: string,
  customerE164: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("contacts")
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
  /**
   * Set for worker-initiated sends from `sms_outbound_log` (AiFlow lead
   * intros etc.) — those rows have no inbound side; `assistantReply` carries
   * the outbound body.
   */
  source?: "ai_flow" | "agent_offer" | "owner_notify";
};

const DEFAULT_SMS_HISTORY_LIMIT = 30;

export async function listSmsHistoryForCustomer(
  businessId: string,
  customerE164: string,
  options: { limit?: number; aliases?: string[] } = {},
  client?: SupabaseClient
): Promise<SmsHistoryEntry[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_SMS_HISTORY_LIMIT),
    100
  );
  // After a profile merge the old number's SMS rows keep their original
  // customer_e164 (history is immutable); pass the profile's alias_e164s so
  // the merged conversation reads as one thread.
  const numbers = [customerE164, ...(options.aliases ?? [])];
  const { data, error } = await db
    .from("sms_inbound_jobs")
    .select("id, payload, assistant_reply_text, rowboat_reply_cached, created_at")
    .eq("business_id", businessId)
    .in("customer_e164", numbers)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSmsHistoryForCustomer: ${error.message}`);
  // Worker-initiated sends (AiFlow lead intros, offers) live in
  // `sms_outbound_log` with no inbound job — without them a lead the flow
  // texted first shows "No SMS history" on the profile even though the
  // thread page renders the message.
  const { data: outboundData, error: outboundError } = await db
    .from("sms_outbound_log")
    .select("id, body, source, created_at")
    .eq("business_id", businessId)
    .in("to_e164", numbers)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (outboundError) {
    throw new Error(`listSmsHistoryForCustomer: ${outboundError.message}`);
  }
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
  const entries: SmsHistoryEntry[] = rows.map((r) => ({
    jobId: r.id,
    inboundText: extractInboundText(r.payload),
    assistantReply: resolveReply(r.assistant_reply_text, r.rowboat_reply_cached),
    receivedAt: r.created_at
  }));
  for (const r of (outboundData as Array<{
    id: string;
    body: string;
    source: "ai_flow" | "agent_offer" | "owner_notify";
    created_at: string;
  }> | null) ?? []) {
    entries.push({
      jobId: r.id,
      inboundText: "",
      assistantReply: r.body,
      receivedAt: r.created_at,
      source: r.source
    });
  }
  // Merge both sources chronologically and keep the most recent `limit`.
  entries.sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0
  );
  return entries.slice(-limit);
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
  // RCS inbound nests content under a body OBJECT: `body.text` for typed
  // messages, `body.suggestion_response.text` for tapped suggested replies.
  // Mirrors inboundTextFromPayload in src/lib/db/sms-history.ts — without
  // this, an RCS-only customer read as "no customer content" and the
  // summarizer skipped (and the summary prompt dropped their messages).
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const body = b as Record<string, unknown>;
    if (typeof body["text"] === "string") return body["text"];
    const suggestion = body["suggestion_response"];
    if (suggestion && typeof suggestion === "object") {
      const st = (suggestion as Record<string, unknown>)["text"];
      if (typeof st === "string") return st;
    }
  }
  return "";
}
