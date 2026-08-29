/**
 * The shared team-chat store (`coworker_conversations` / `coworker_messages`
 * / `coworker_jobs`), one pipeline for every channel where a business's own
 * people reach their coworker.
 *
 * This replaces `slack_chat.ts`, which was itself a retargeted copy of the
 * messenger_* store. Every function here is the Slack one with `channel`
 * carried through and the Slack-shaped names generalised (`thread_ts` became
 * `thread_key`, because only Slack anchors a thread on a timestamp).
 *
 * Service-role only (RLS on, no policies). A webhook writes here inside its
 * provider's ack window, which is as short as 3 seconds on Slack, so every
 * function is one round trip. The claim / complete / reclaim primitives are
 * SQL RPCs so their locking lives beside the schema.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Channels that run a two-way coworker conversation. */
export type CoworkerChannel = "slack" | "telegram";

export type CoworkerConversationRow = {
  id: string;
  business_id: string;
  channel: CoworkerChannel;
  external_workspace_id: string | null;
  external_conversation_id: string;
  thread_key: string | null;
  external_user_id: string;
  user_display_name: string | null;
  user_email: string | null;
  user_phone_e164: string | null;
  is_owner: boolean;
  last_user_message_at: string;
  created_at: string;
  updated_at: string;
};

export type CoworkerMessageRow = {
  id: number;
  conversation_id: string;
  business_id: string;
  channel: CoworkerChannel;
  role: "user" | "assistant";
  content: string;
  external_event_id: string | null;
  external_ts: string | null;
  created_at: string;
};

export type CoworkerJobRow = {
  id: string;
  business_id: string;
  channel: CoworkerChannel;
  conversation_id: string;
  user_message_id: number;
  status: "queued" | "processing" | "done" | "error";
  attempts: number;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  assistant_message_id: number | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
};

export type CoworkerConversationScope = {
  businessId: string;
  channel: CoworkerChannel;
  externalWorkspaceId: string | null;
  externalConversationId: string;
  /** Null when the conversation IS the thread, e.g. a DM. */
  threadKey: string | null;
  externalUserId: string;
};

/**
 * The scope query, built once. `thread_key` needs `.is(null)` rather than
 * `.eq(null)` for the DM case, and getting that wrong would silently match
 * no rows and create a fresh conversation on every single message.
 */
function scopeQuery(db: SupabaseClient, scope: CoworkerConversationScope) {
  const base = db
    .from("coworker_conversations")
    .select("*")
    .eq("business_id", scope.businessId)
    .eq("channel", scope.channel)
    .eq("external_conversation_id", scope.externalConversationId)
    .eq("external_user_id", scope.externalUserId);
  return scope.threadKey === null
    ? base.is("thread_key", null)
    : base.eq("thread_key", scope.threadKey);
}

/** Find-or-create the conversation for one (place, thread, speaker). */
export async function getOrCreateCoworkerConversation(
  scope: CoworkerConversationScope,
  client?: SupabaseClient
): Promise<CoworkerConversationRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await scopeQuery(db, scope).maybeSingle();
  if (readError) throw new Error(`getOrCreateCoworkerConversation: ${readError.message}`);
  if (existing) return existing as CoworkerConversationRow;

  const { data, error } = await db
    .from("coworker_conversations")
    .insert({
      business_id: scope.businessId,
      channel: scope.channel,
      external_workspace_id: scope.externalWorkspaceId,
      external_conversation_id: scope.externalConversationId,
      thread_key: scope.threadKey,
      external_user_id: scope.externalUserId
    })
    .select("*")
    .single();
  if (error) {
    // Unique-scope race (two events for a brand-new conversation): re-read.
    if ((error as { code?: string }).code === "23505") {
      const { data: raced, error: rereadError } = await scopeQuery(db, scope).maybeSingle();
      if (rereadError || !raced) {
        throw new Error(
          `getOrCreateCoworkerConversation: ${rereadError?.message ?? "race re-read found nothing"}`
        );
      }
      return raced as CoworkerConversationRow;
    }
    throw new Error(`getOrCreateCoworkerConversation: ${error.message}`);
  }
  return data as CoworkerConversationRow;
}

/** Cache the identity verdict on the conversation (one lookup per thread). */
export async function updateCoworkerConversationIdentity(
  conversationId: string,
  identity: {
    displayName: string | null;
    email: string | null;
    phoneE164?: string | null;
    isOwner: boolean;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("coworker_conversations")
    .update({
      user_display_name: identity.displayName,
      user_email: identity.email,
      // Omitted rather than nulled when the caller has nothing to say about
      // it: a channel that resolves an email must not wipe a phone number
      // another enrolment step established.
      ...(identity.phoneE164 === undefined ? {} : { user_phone_e164: identity.phoneE164 }),
      is_owner: identity.isOwner,
      updated_at: new Date().toISOString()
    })
    .eq("id", conversationId);
  if (error) throw new Error(`updateCoworkerConversationIdentity: ${error.message}`);
}

/**
 * Store an inbound user message + its reply job. Returns null when the
 * event id already exists, which every one of these providers produces by
 * redelivering on a slow ack. That is the ack-and-move-on signal, not an
 * error: treating it as one would answer the same message twice.
 */
export async function insertCoworkerUserMessage(
  input: {
    conversationId: string;
    businessId: string;
    channel: CoworkerChannel;
    content: string;
    externalEventId: string | null;
    externalTs: string | null;
  },
  client?: SupabaseClient
): Promise<{ messageId: number; jobId: string } | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: message, error } = await db
    .from("coworker_messages")
    .insert({
      conversation_id: input.conversationId,
      business_id: input.businessId,
      channel: input.channel,
      role: "user",
      content: input.content,
      external_event_id: input.externalEventId,
      external_ts: input.externalTs
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw new Error(`insertCoworkerUserMessage: ${error.message}`);
  }

  const messageId = (message as { id: number }).id;
  const { data: job, error: jobError } = await db
    .from("coworker_jobs")
    .insert({
      business_id: input.businessId,
      channel: input.channel,
      conversation_id: input.conversationId,
      user_message_id: messageId
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`insertCoworkerUserMessage: ${jobError.message}`);

  const { error: bumpError } = await db
    .from("coworker_conversations")
    .update({
      last_user_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", input.conversationId);
  if (bumpError) throw new Error(`insertCoworkerUserMessage: ${bumpError.message}`);

  return { messageId, jobId: (job as { id: string }).id };
}

/**
 * Exactly-once claim for the onboarding hello: an assistant row keyed by a
 * synthetic per-conversation event id, so racing "app opened" deliveries
 * collapse onto the unique index instead of double-greeting. Returns false
 * when someone else (or an earlier open) already claimed it.
 */
export async function markCoworkerHelloSent(
  input: {
    conversationId: string;
    businessId: string;
    channel: CoworkerChannel;
    content: string;
  },
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("coworker_messages").insert({
    conversation_id: input.conversationId,
    business_id: input.businessId,
    channel: input.channel,
    role: "assistant",
    content: input.content,
    external_event_id: `hello:${input.conversationId}`
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw new Error(`markCoworkerHelloSent: ${error.message}`);
  }
  return true;
}

/** Atomic claim of the next runnable job, any channel (0 or 1 row). */
export async function claimCoworkerJob(
  workerId: string,
  client?: SupabaseClient
): Promise<CoworkerJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("claim_coworker_job", { p_worker_id: workerId });
  if (error) throw new Error(`claimCoworkerJob: ${error.message}`);
  const rows = (data ?? []) as CoworkerJobRow[];
  return rows.length > 0 ? rows[0] : null;
}

export async function getCoworkerConversationById(
  conversationId: string,
  client?: SupabaseClient
): Promise<CoworkerConversationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`getCoworkerConversationById: ${error.message}`);
  return (data as CoworkerConversationRow | null) ?? null;
}

/** The turn's history window, oldest first, bounded. */
export async function listCoworkerMessages(
  conversationId: string,
  limit: number,
  client?: SupabaseClient
): Promise<CoworkerMessageRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listCoworkerMessages: ${error.message}`);
  return ((data ?? []) as CoworkerMessageRow[]).reverse();
}

/** Atomic completion via RPC (assistant row + supersede + done). */
export async function completeCoworkerJob(
  input: {
    jobId: string;
    content: string;
    historyMaxMessageId: number;
    externalTs: string | null;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("coworker_job_complete", {
    p_job_id: input.jobId,
    p_content: input.content,
    p_history_max_message_id: input.historyMaxMessageId,
    p_external_ts: input.externalTs
  });
  if (error) throw new Error(`completeCoworkerJob: ${error.message}`);
}

/**
 * Terminal or retryable failure. Terminal failures (the tier gate, a
 * switched-off surface, nothing to answer) mark the job error immediately so
 * the stale-reclaim never loops them; retryable ones requeue until the claim
 * RPC's attempts<3 ceiling holds.
 */
export async function failCoworkerJob(
  input: { jobId: string; errorCode: string; errorDetail?: string; terminal: boolean },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("coworker_jobs")
    .update({
      status: input.terminal ? "error" : "queued",
      error_code: input.errorCode,
      error_detail: input.errorDetail ?? null,
      claimed_by: null,
      claimed_at: null,
      ...(input.terminal ? { completed_at: new Date().toISOString() } : {})
    })
    .eq("id", input.jobId);
  if (error) throw new Error(`failCoworkerJob: ${error.message}`);
}

/** Sweep entry: requeue wedged claims (>10 min), error-out max attempts. */
export async function reclaimStaleCoworkerJobs(client?: SupabaseClient): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("coworker_jobs_reclaim_stale");
  if (error) throw new Error(`reclaimStaleCoworkerJobs: ${error.message}`);
  return typeof data === "number" ? data : 0;
}
