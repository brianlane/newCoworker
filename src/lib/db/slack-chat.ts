/**
 * Slack chat pipeline store (`slack_conversations` / `slack_messages` /
 * `slack_jobs`), the messenger_* mirror for the TEAM-facing Slack surface.
 *
 * Service-role only (RLS on, no policies). The webhook writes here inside
 * its 3-second ack window, so every function is one round trip; the claim /
 * complete / reclaim primitives are SQL RPCs from 20260822113428 so their
 * locking lives beside the schema.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SlackConversationRow = {
  id: string;
  business_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string | null;
  slack_user_id: string;
  user_display_name: string | null;
  user_email: string | null;
  is_owner: boolean;
  last_user_message_at: string;
  created_at: string;
  updated_at: string;
};

export type SlackMessageRow = {
  id: number;
  conversation_id: string;
  business_id: string;
  role: "user" | "assistant";
  content: string;
  slack_event_id: string | null;
  slack_ts: string | null;
  created_at: string;
};

export type SlackJobRow = {
  id: string;
  business_id: string;
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

/** Find-or-create the conversation for one (channel, thread, speaker). */
export async function getOrCreateSlackConversation(
  input: {
    businessId: string;
    teamId: string;
    channelId: string;
    threadTs: string | null;
    slackUserId: string;
  },
  client?: SupabaseClient
): Promise<SlackConversationRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("slack_conversations")
    .select("*")
    .eq("business_id", input.businessId)
    .eq("channel_id", input.channelId)
    .eq("slack_user_id", input.slackUserId);
  const { data: existing, error: readError } = await (input.threadTs === null
    ? base.is("thread_ts", null)
    : base.eq("thread_ts", input.threadTs)
  ).maybeSingle();
  if (readError) throw new Error(`getOrCreateSlackConversation: ${readError.message}`);
  if (existing) return existing as SlackConversationRow;

  const { data, error } = await db
    .from("slack_conversations")
    .insert({
      business_id: input.businessId,
      team_id: input.teamId,
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      slack_user_id: input.slackUserId
    })
    .select("*")
    .single();
  if (error) {
    // Unique-scope race (two events for a brand-new conversation): re-read.
    if ((error as { code?: string }).code === "23505") {
      const { data: raced, error: rereadError } = await (input.threadTs === null
        ? db
            .from("slack_conversations")
            .select("*")
            .eq("business_id", input.businessId)
            .eq("channel_id", input.channelId)
            .eq("slack_user_id", input.slackUserId)
            .is("thread_ts", null)
        : db
            .from("slack_conversations")
            .select("*")
            .eq("business_id", input.businessId)
            .eq("channel_id", input.channelId)
            .eq("slack_user_id", input.slackUserId)
            .eq("thread_ts", input.threadTs)
      ).maybeSingle();
      if (rereadError || !raced) {
        throw new Error(
          `getOrCreateSlackConversation: ${rereadError?.message ?? "race re-read found nothing"}`
        );
      }
      return raced as SlackConversationRow;
    }
    throw new Error(`getOrCreateSlackConversation: ${error.message}`);
  }
  return data as SlackConversationRow;
}

/** Cache the users.info verdict on the conversation (one lookup per thread). */
export async function updateSlackConversationIdentity(
  conversationId: string,
  identity: { displayName: string | null; email: string | null; isOwner: boolean },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("slack_conversations")
    .update({
      user_display_name: identity.displayName,
      user_email: identity.email,
      is_owner: identity.isOwner,
      updated_at: new Date().toISOString()
    })
    .eq("id", conversationId);
  if (error) throw new Error(`updateSlackConversationIdentity: ${error.message}`);
}

/**
 * Store an inbound user message + its reply job. Returns null when the
 * event id already exists (Slack's 0/1/5-min redelivery), which is the
 * ack-and-move-on signal, not an error.
 */
export async function insertSlackUserMessage(
  input: {
    conversationId: string;
    businessId: string;
    content: string;
    slackEventId: string | null;
    slackTs: string | null;
  },
  client?: SupabaseClient
): Promise<{ messageId: number; jobId: string } | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: message, error } = await db
    .from("slack_messages")
    .insert({
      conversation_id: input.conversationId,
      business_id: input.businessId,
      role: "user",
      content: input.content,
      slack_event_id: input.slackEventId,
      slack_ts: input.slackTs
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw new Error(`insertSlackUserMessage: ${error.message}`);
  }

  const messageId = (message as { id: number }).id;
  const { data: job, error: jobError } = await db
    .from("slack_jobs")
    .insert({
      business_id: input.businessId,
      conversation_id: input.conversationId,
      user_message_id: messageId
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`insertSlackUserMessage: ${jobError.message}`);

  const { error: bumpError } = await db
    .from("slack_conversations")
    .update({
      last_user_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", input.conversationId);
  if (bumpError) throw new Error(`insertSlackUserMessage: ${bumpError.message}`);

  return { messageId, jobId: (job as { id: string }).id };
}

/** Atomic claim of the next runnable job (0 or 1 row). */
export async function claimSlackJob(
  workerId: string,
  client?: SupabaseClient
): Promise<SlackJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("claim_slack_job", { p_worker_id: workerId });
  if (error) throw new Error(`claimSlackJob: ${error.message}`);
  const rows = (data ?? []) as SlackJobRow[];
  return rows.length > 0 ? rows[0] : null;
}

export async function getSlackConversationById(
  conversationId: string,
  client?: SupabaseClient
): Promise<SlackConversationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("slack_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`getSlackConversationById: ${error.message}`);
  return (data as SlackConversationRow | null) ?? null;
}

/** The turn's history window, oldest first, bounded. */
export async function listSlackMessages(
  conversationId: string,
  limit: number,
  client?: SupabaseClient
): Promise<SlackMessageRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("slack_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSlackMessages: ${error.message}`);
  return ((data ?? []) as SlackMessageRow[]).reverse();
}

/** Atomic completion via RPC (assistant row + supersede + done). */
export async function completeSlackJob(
  input: {
    jobId: string;
    content: string;
    historyMaxMessageId: number;
    slackTs: string | null;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("slack_job_complete", {
    p_job_id: input.jobId,
    p_content: input.content,
    p_history_max_message_id: input.historyMaxMessageId,
    p_slack_ts: input.slackTs
  });
  if (error) throw new Error(`completeSlackJob: ${error.message}`);
}

/**
 * Terminal or retryable failure. Terminal failures (tier gate) mark the
 * job error immediately so the stale-reclaim never loops them; retryable
 * ones requeue until the claim RPC's attempts<3 ceiling holds.
 */
export async function failSlackJob(
  input: { jobId: string; errorCode: string; errorDetail?: string; terminal: boolean },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("slack_jobs")
    .update({
      status: input.terminal ? "error" : "queued",
      error_code: input.errorCode,
      error_detail: input.errorDetail ?? null,
      claimed_by: null,
      claimed_at: null,
      ...(input.terminal ? { completed_at: new Date().toISOString() } : {})
    })
    .eq("id", input.jobId);
  if (error) throw new Error(`failSlackJob: ${error.message}`);
}

/** Sweep entry: requeue wedged claims (>10 min), error-out max attempts. */
export async function reclaimStaleSlackJobs(client?: SupabaseClient): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("slack_jobs_reclaim_stale");
  if (error) throw new Error(`reclaimStaleSlackJobs: ${error.message}`);
  return typeof data === "number" ? data : 0;
}
