/**
 * Service-role data access for the website chat widget
 * (chat_widget_settings / webchat_sessions / webchat_messages /
 * webchat_jobs — migration 20260819000000_webchat_widget.sql).
 *
 * Every table is RLS-on/no-policies, so ALL access flows through here after
 * the caller's own auth: the public widget routes verify the site key +
 * per-session bearer (src/lib/webchat/service.ts) and the dashboard routes
 * gate on requireBusinessRole — same trust model as db/dashboard-chat.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { mintWidgetKey } from "@/lib/webchat/keys";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WebchatReplyEngine = "vps" | "gemini";

export type ChatWidgetSettingsRow = {
  business_id: string;
  enabled: boolean;
  public_key: string;
  public_key_sha256: string;
  allowed_origins: string[];
  require_contact_form: boolean;
  theme: unknown | null;
  /**
   * Who answers widget turns: 'vps' = the box chat-worker (default),
   * 'gemini' = the platform-side direct responder (no VPS required) —
   * see src/lib/webchat/gemini-engine.ts. Admin-only knob; optional on
   * the type for rows read before 20260805000100_webchat_reply_engine.
   */
  reply_engine?: WebchatReplyEngine;
  created_at: string;
  updated_at: string;
};

/** Defensive read of the reply engine: anything but 'gemini' means 'vps'. */
export function webchatReplyEngine(
  settings: Pick<ChatWidgetSettingsRow, "reply_engine">
): WebchatReplyEngine {
  return settings.reply_engine === "gemini" ? "gemini" : "vps";
}

export type WebchatSessionRow = {
  id: string;
  business_id: string;
  session_token_sha256: string;
  visitor_name: string | null;
  visitor_email: string | null;
  visitor_phone: string | null;
  rowboat_conversation_id: string | null;
  rowboat_state: unknown | null;
  last_seen_at: string;
  created_at: string;
};

export type WebchatMessageRole = "user" | "assistant" | "system";

export type WebchatMessageRow = {
  id: number;
  session_id: string;
  business_id: string;
  role: WebchatMessageRole;
  content: string;
  client_message_id?: string | null;
  created_at: string;
};

export type WebchatJobRow = {
  id: string;
  business_id: string;
  session_id: string;
  user_message_id: number;
  status: "queued" | "processing" | "done" | "error";
  attempts: number;
  assistant_message_id: number | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  completed_at: string | null;
  /**
   * Pre-built turn input (see /api/widget/message). Present only on reads
   * that select them (getWebchatJobById) — the Gemini reply engine consumes
   * stateless_input_messages ?? input_messages, the same precedence the
   * chat-worker applies to its always-stateless turns.
   */
  input_messages?: Array<{ role: WebchatMessageRole; content: string }> | null;
  stateless_input_messages?: Array<{ role: WebchatMessageRole; content: string }> | null;
  /** Present on platform claim/reclaim reads — identifies THIS claim generation. */
  claimed_at?: string | null;
};

/**
 * API-shape projection of stored messages — single source of truth for the
 * `{ id, role, content, createdAt }` envelope the widget poll route and the
 * owner transcript route both return (mirrors serializeChatMessages).
 */
export function serializeWebchatMessages(rows: WebchatMessageRow[]) {
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.created_at
  }));
}

// ---------------------------------------------------------------------
// chat_widget_settings
// ---------------------------------------------------------------------

export async function getWidgetSettingsForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<ChatWidgetSettingsRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("chat_widget_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getWidgetSettingsForBusiness: ${error.message}`);
  return (data as ChatWidgetSettingsRow | null) ?? null;
}

export async function getWidgetSettingsByKeyHash(
  keySha256: string,
  client?: SupabaseClient
): Promise<ChatWidgetSettingsRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("chat_widget_settings")
    .select("*")
    .eq("public_key_sha256", keySha256)
    .maybeSingle();
  if (error) throw new Error(`getWidgetSettingsByKeyHash: ${error.message}`);
  return (data as ChatWidgetSettingsRow | null) ?? null;
}

/**
 * Get the business's widget settings, minting the row (disabled, fresh
 * site key) on first touch. Two concurrent first-touches can race the
 * insert; the primary key makes one lose — we swallow that and re-read the
 * winner (same pattern as getOrCreateActiveThread).
 */
export async function getOrCreateWidgetSettings(
  businessId: string,
  client?: SupabaseClient
): Promise<ChatWidgetSettingsRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const existing = await getWidgetSettingsForBusiness(businessId, db);
  if (existing) return existing;
  const key = mintWidgetKey();
  const { data, error } = await db
    .from("chat_widget_settings")
    .insert({
      business_id: businessId,
      enabled: false,
      public_key: key.plaintext,
      public_key_sha256: key.hash
    })
    .select()
    .single();
  if (!error) return data as ChatWidgetSettingsRow;
  const winner = await getWidgetSettingsForBusiness(businessId, db);
  if (winner) return winner;
  throw new Error(`getOrCreateWidgetSettings: ${error.message}`);
}

export type WidgetSettingsPatch = {
  enabled?: boolean;
  allowed_origins?: string[];
  require_contact_form?: boolean;
  theme?: unknown | null;
  reply_engine?: WebchatReplyEngine;
};

export async function updateWidgetSettings(
  businessId: string,
  patch: WidgetSettingsPatch,
  client?: SupabaseClient
): Promise<ChatWidgetSettingsRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("chat_widget_settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .select()
    .single();
  if (error) throw new Error(`updateWidgetSettings: ${error.message}`);
  return data as ChatWidgetSettingsRow;
}

/**
 * Rotate the site key. Old embeds stop resolving immediately — the owner
 * settings card shows the new snippet to paste. Returns the updated row
 * (public_key is the new plaintext; it is public by design).
 */
export async function regenerateWidgetKey(
  businessId: string,
  client?: SupabaseClient
): Promise<ChatWidgetSettingsRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const key = mintWidgetKey();
  const { data, error } = await db
    .from("chat_widget_settings")
    .update({
      public_key: key.plaintext,
      public_key_sha256: key.hash,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .select()
    .single();
  if (error) throw new Error(`regenerateWidgetKey: ${error.message}`);
  return data as ChatWidgetSettingsRow;
}

// ---------------------------------------------------------------------
// webchat_sessions
// ---------------------------------------------------------------------

export type WebchatContactPatch = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export async function createWebchatSession(
  businessId: string,
  sessionTokenSha256: string,
  contact: WebchatContactPatch,
  client?: SupabaseClient
): Promise<WebchatSessionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_sessions")
    .insert({
      business_id: businessId,
      session_token_sha256: sessionTokenSha256,
      visitor_name: contact.name?.trim() || null,
      visitor_email: contact.email?.trim() || null,
      visitor_phone: contact.phone?.trim() || null
    })
    .select()
    .single();
  if (error) throw new Error(`createWebchatSession: ${error.message}`);
  return data as WebchatSessionRow;
}

export async function getWebchatSessionByTokenHash(
  sessionTokenSha256: string,
  client?: SupabaseClient
): Promise<WebchatSessionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_sessions")
    .select("*")
    .eq("session_token_sha256", sessionTokenSha256)
    .maybeSingle();
  if (error) throw new Error(`getWebchatSessionByTokenHash: ${error.message}`);
  return (data as WebchatSessionRow | null) ?? null;
}

/**
 * Merge captured contact details onto the session. New NON-EMPTY values win
 * (a visitor correcting a typo mid-conversation should overwrite), empty /
 * missing fields leave the stored value alone.
 */
export async function updateWebchatSessionContact(
  sessionId: string,
  contact: WebchatContactPatch,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const patch: Record<string, string> = {};
  const name = contact.name?.trim();
  const email = contact.email?.trim();
  const phone = contact.phone?.trim();
  if (name) patch.visitor_name = name;
  if (email) patch.visitor_email = email;
  if (phone) patch.visitor_phone = phone;
  if (Object.keys(patch).length === 0) return;
  const { error } = await db
    .from("webchat_sessions")
    .update(patch)
    .eq("id", sessionId);
  if (error) throw new Error(`updateWebchatSessionContact: ${error.message}`);
}

/** Session lookup by primary key, for tool-call sessionRef validation. */
export async function getWebchatSessionById(
  sessionId: string,
  client?: SupabaseClient
): Promise<WebchatSessionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`getWebchatSessionById: ${error.message}`);
  return (data as WebchatSessionRow | null) ?? null;
}

/** Bump last_seen_at so the idle-TTL window slides with real activity. */
export async function touchWebchatSession(
  sessionId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("webchat_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw new Error(`touchWebchatSession: ${error.message}`);
}

/** A session row plus its message count, for the owner's Web chat list. */
export type WebchatSessionSummary = WebchatSessionRow & { message_count: number };

export async function listWebchatSessionsForBusiness(
  businessId: string,
  opts: { limit?: number } = {},
  client?: SupabaseClient
): Promise<WebchatSessionSummary[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? 50;
  const { data, error } = await db
    .from("webchat_sessions")
    .select(
      "id, business_id, session_token_sha256, visitor_name, visitor_email, visitor_phone, rowboat_conversation_id, rowboat_state, last_seen_at, created_at, webchat_messages(count)"
    )
    .eq("business_id", businessId)
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listWebchatSessionsForBusiness: ${error.message}`);
  type EmbeddedRow = WebchatSessionRow & {
    webchat_messages?: Array<{ count?: number }> | null;
  };
  return ((data as EmbeddedRow[] | null) ?? []).map((row) => {
    const { webchat_messages, ...rest } = row;
    const count = Array.isArray(webchat_messages)
      ? Number(webchat_messages[0]?.count ?? 0)
      : 0;
    return { ...rest, message_count: Number.isFinite(count) ? count : 0 };
  });
}

/**
 * A session row plus its message count and owning business name, for the
 * fleet-wide admin Web chat index (/admin/webchat) — the review surface
 * for widgets with no tenant dashboard behind them (e.g. the platform's
 * own direct-Gemini marketing-site tenant).
 */
export type WebchatSessionAdminSummary = WebchatSessionSummary & {
  business_name: string;
};

export async function listRecentWebchatSessions(
  opts: { limit?: number } = {},
  client?: SupabaseClient
): Promise<WebchatSessionAdminSummary[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? 100;
  const { data, error } = await db
    .from("webchat_sessions")
    .select(
      "id, business_id, session_token_sha256, visitor_name, visitor_email, visitor_phone, rowboat_conversation_id, rowboat_state, last_seen_at, created_at, webchat_messages(count), businesses(name)"
    )
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentWebchatSessions: ${error.message}`);
  type EmbeddedRow = WebchatSessionRow & {
    webchat_messages?: Array<{ count?: number }> | null;
    businesses?: { name?: unknown } | null;
  };
  return ((data as EmbeddedRow[] | null) ?? []).map((row) => {
    const { webchat_messages, businesses, ...rest } = row;
    const count = Array.isArray(webchat_messages)
      ? Number(webchat_messages[0]?.count ?? 0)
      : 0;
    return {
      ...rest,
      message_count: Number.isFinite(count) ? count : 0,
      business_name: typeof businesses?.name === "string" ? businesses.name : ""
    };
  });
}

// ---------------------------------------------------------------------
// webchat_messages
// ---------------------------------------------------------------------

export async function appendWebchatMessage(
  sessionId: string,
  businessId: string,
  role: WebchatMessageRole,
  content: string,
  opts: { clientMessageId?: string | null } = {},
  client?: SupabaseClient
): Promise<WebchatMessageRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_messages")
    .insert({
      session_id: sessionId,
      business_id: businessId,
      role,
      content,
      client_message_id: opts.clientMessageId ?? null
    })
    .select()
    .single();
  if (error) throw new Error(`appendWebchatMessage: ${error.message}`);
  return data as WebchatMessageRow;
}

/** Postgres unique-violation detector (same heuristics as dashboard-chat). */
export function isWebchatUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("23505") || msg.toLowerCase().includes("duplicate key");
}

/**
 * Idempotent-send lookup: the visitor message previously persisted under
 * this client-generated id, if any. Backs the widget's retry-after-network-
 * failure path so one send can never produce two rows / two jobs.
 */
export async function getWebchatMessageByClientId(
  sessionId: string,
  clientMessageId: string,
  client?: SupabaseClient
): Promise<WebchatMessageRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .eq("client_message_id", clientMessageId)
    .maybeSingle();
  if (error) throw new Error(`getWebchatMessageByClientId: ${error.message}`);
  return (data as WebchatMessageRow | null) ?? null;
}

/**
 * Compensating delete for the enqueue-failed path: a visitor turn whose job
 * insert failed is removed so the transcript never carries a message no
 * worker will ever answer.
 */
export async function deleteWebchatMessage(
  messageId: number,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("webchat_messages").delete().eq("id", messageId);
  if (error) throw new Error(`deleteWebchatMessage: ${error.message}`);
}

export async function listWebchatMessages(
  sessionId: string,
  client?: SupabaseClient
): Promise<WebchatMessageRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("id", { ascending: true });
  if (error) throw new Error(`listWebchatMessages: ${error.message}`);
  return (data as WebchatMessageRow[] | null) ?? [];
}

/** Poll cursor: everything on the session with id > afterId, in order. */
export async function listWebchatMessagesSince(
  sessionId: string,
  afterId: number,
  client?: SupabaseClient
): Promise<WebchatMessageRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .gt("id", afterId)
    .order("id", { ascending: true });
  if (error) throw new Error(`listWebchatMessagesSince: ${error.message}`);
  return (data as WebchatMessageRow[] | null) ?? [];
}

/**
 * Count of VISITOR messages for a business since `sinceIso` — the
 * per-business daily ceiling read (abuse control on an anonymous surface).
 */
export async function countWebchatUserMessagesSince(
  businessId: string,
  sinceIso: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("webchat_messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("role", "user")
    .gte("created_at", sinceIso);
  if (error) throw new Error(`countWebchatUserMessagesSince: ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------------
// webchat_jobs
// ---------------------------------------------------------------------

export type InsertWebchatJobInput = {
  businessId: string;
  sessionId: string;
  userMessageId: number;
  inputMessages: Array<{ role: WebchatMessageRole; content: string }>;
  statelessInputMessages: Array<{ role: WebchatMessageRole; content: string }> | null;
  rowboatConversationId: string | null;
};

export async function insertWebchatJob(
  input: InsertWebchatJobInput,
  client?: SupabaseClient
): Promise<WebchatJobRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_jobs")
    .insert({
      business_id: input.businessId,
      session_id: input.sessionId,
      user_message_id: input.userMessageId,
      input_messages: input.inputMessages,
      stateless_input_messages: input.statelessInputMessages,
      rowboat_conversation_id: input.rowboatConversationId
    })
    .select()
    .single();
  if (error) throw new Error(`insertWebchatJob: ${error.message}`);
  return data as WebchatJobRow;
}

/**
 * The job enqueued for a given visitor message (newest wins if a retried
 * enqueue ever produced more than one). Backs the idempotent-send replay:
 * a duplicate POST returns the ORIGINAL turn's jobId so the widget resumes
 * polling instead of double-generating.
 */
export async function getWebchatJobForUserMessage(
  userMessageId: number,
  client?: SupabaseClient
): Promise<WebchatJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_jobs")
    .select(
      "id, business_id, session_id, user_message_id, status, attempts, assistant_message_id, error_code, error_detail, created_at, completed_at"
    )
    .eq("user_message_id", userMessageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getWebchatJobForUserMessage: ${error.message}`);
  return (data as WebchatJobRow | null) ?? null;
}

export async function getWebchatJobById(
  jobId: string,
  client?: SupabaseClient
): Promise<WebchatJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webchat_jobs")
    .select(
      "id, business_id, session_id, user_message_id, status, attempts, assistant_message_id, error_code, error_detail, created_at, completed_at, input_messages, stateless_input_messages"
    )
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`getWebchatJobById: ${error.message}`);
  return (data as WebchatJobRow | null) ?? null;
}

// ---------------------------------------------------------------------
// Platform-side (Gemini reply engine) job lifecycle. The box chat-worker
// claims via the claim_webchat_job RPC; the platform engine claims with a
// conditional UPDATE — the `status = 'queued'` filter is the lock, so a
// worker that somehow raced us matches zero rows and exactly one engine
// ever answers a job.
// ---------------------------------------------------------------------

/** claimed_by marker for platform-engine claims (worker ids are hostnames). */
export const WEBCHAT_PLATFORM_WORKER_ID = "platform-gemini-engine";

/**
 * Sentinel stored in webchat_sessions.rowboat_conversation_id after a
 * platform-engine reply. The enqueue route treats ANY non-empty value as
 * "this session has prior history" and switches to the full 20-message
 * stateless tail — without it, gemini-engine tenants would be stuck on the
 * 8-message resend tail forever and multi-turn chats would lose context
 * versus the worker path (Bugbot Medium on PR #592). Harmless if the
 * tenant later flips back to 'vps': the worker never RESUMES the id (all
 * webchat turns are stateless-forced) and overwrites it with a real
 * Rowboat id on its next completed turn.
 */
export const WEBCHAT_ENGINE_HISTORY_MARKER = "platform-gemini-engine";

/**
 * A platform claim older than this is stealable by a later poll. Sized
 * well past the engine's whole-turn deadline (30s) so a live turn can
 * never be double-answered; a crashed/killed route (or a failed
 * error-flip) is retried instead of leaving the job wedged 'processing'
 * with nobody to reclaim it (gemini tenants have no box-side reclaimer).
 */
export const WEBCHAT_PLATFORM_RECLAIM_AFTER_MS = 60_000;

/**
 * Atomically claim a still-queued job for the platform engine. Null when
 * the claim lost (already claimed/answered) — the caller just re-reads.
 */
export async function claimWebchatJobForPlatform(
  jobId: string,
  client?: SupabaseClient
): Promise<WebchatJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("webchat_jobs")
    .update({
      status: "processing",
      claimed_by: WEBCHAT_PLATFORM_WORKER_ID,
      claimed_at: nowIso,
      started_at: nowIso
    })
    .eq("id", jobId)
    .eq("status", "queued")
    .select(
      "id, business_id, session_id, user_message_id, status, attempts, assistant_message_id, error_code, error_detail, created_at, completed_at, claimed_at, input_messages, stateless_input_messages"
    )
    .maybeSingle();
  if (error) throw new Error(`claimWebchatJobForPlatform: ${error.message}`);
  return (data as WebchatJobRow | null) ?? null;
}

/**
 * Steal a WEDGED platform claim: same conditional-UPDATE lock, but against
 * a 'processing' row whose platform claim went stale (route crashed
 * mid-turn, or the error-flip itself failed). Guarded to the platform's
 * own claimed_by — a box worker's in-flight claim is never stolen (its own
 * reclaimer owns that). Null when the row is absent, healthy, or raced.
 */
export async function reclaimStaleWebchatJobForPlatform(
  jobId: string,
  client?: SupabaseClient,
  now: Date = new Date()
): Promise<WebchatJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const cutoffIso = new Date(now.getTime() - WEBCHAT_PLATFORM_RECLAIM_AFTER_MS).toISOString();
  const { data, error } = await db
    .from("webchat_jobs")
    .update({
      status: "processing",
      claimed_by: WEBCHAT_PLATFORM_WORKER_ID,
      claimed_at: now.toISOString()
    })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("claimed_by", WEBCHAT_PLATFORM_WORKER_ID)
    .lt("claimed_at", cutoffIso)
    .select(
      "id, business_id, session_id, user_message_id, status, attempts, assistant_message_id, error_code, error_detail, created_at, completed_at, claimed_at, input_messages, stateless_input_messages"
    )
    .maybeSingle();
  if (error) throw new Error(`reclaimStaleWebchatJobForPlatform: ${error.message}`);
  return (data as WebchatJobRow | null) ?? null;
}

/**
 * Persist the engine's reply ATOMICALLY via the
 * `webchat_job_complete_platform` RPC: assistant message + session bump
 * (last_seen + the sticky history marker) + job → done, one transaction.
 * Returns the assistant message id.
 *
 * Atomicity is load-bearing (Bugbot High on PR #592): with separate
 * writes, "message inserted but job flip failed" left a 'processing' row
 * the stale-claim reclaim would answer AGAIN — duplicate assistant reply,
 * double Gemini billing. The RPC makes partial states impossible, and a
 * replay against an already-done job idempotently returns the original
 * message id.
 */
export async function completeWebchatJobFromPlatform(
  job: Pick<WebchatJobRow, "id">,
  content: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("webchat_job_complete_platform", {
    p_job_id: job.id,
    p_content: content,
    p_history_marker: WEBCHAT_ENGINE_HISTORY_MARKER
  });
  if (error) throw new Error(`completeWebchatJobFromPlatform: ${error.message}`);
  const msgId = Number(data);
  if (!Number.isFinite(msgId)) {
    throw new Error(`completeWebchatJobFromPlatform: non-numeric message id ${String(data)}`);
  }
  return msgId;
}

/**
 * Flip a platform-claimed job to error (the widget shows its retry copy).
 * Guarded to rows still processing under THIS claim generation
 * (`claimed_at` is the token): after a stale reclaim, two requests can
 * briefly hold the same turn, and the slow loser's catch path must never
 * stamp 'error' over a job the winner committed as 'done' (Bugbot High on
 * PR #592) — nor over a fresh claim a later reclaimer took. A raced flip
 * matches zero rows, which is exactly right.
 */
export async function failWebchatJobFromPlatform(
  jobId: string,
  code: string,
  detail: string,
  /** The failing claim's own claimed_at (from claim/reclaim). */
  claimedAt: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("webchat_jobs")
    .update({
      status: "error",
      error_code: code.slice(0, 100),
      error_detail: detail.slice(0, 500),
      completed_at: new Date().toISOString()
    })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("claimed_by", WEBCHAT_PLATFORM_WORKER_ID)
    .eq("claimed_at", claimedAt);
  if (error) throw new Error(`failWebchatJobFromPlatform: ${error.message}`);
}
