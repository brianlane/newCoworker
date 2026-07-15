/**
 * Service-role data access for the Messenger/Instagram DM channel
 * (messenger_conversations / messenger_messages / messenger_jobs —
 * migration 20260715201015_messenger_channel.sql).
 *
 * Every table is RLS-on/no-policies, so ALL access flows through here
 * after the caller's own auth: the Meta webhook route verifies the
 * X-Hub-Signature-256 first, the internal worker requires the cron
 * bearer, and the dashboard routes gate on requireBusinessRole — same
 * trust model as webchat/db.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type MessengerPlatform = "messenger" | "instagram";

/** Meta's standard messaging window: replies allowed for 24h after the
 * lead's last message. */
export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessengerConversationRow = {
  id: string;
  business_id: string;
  page_id: string;
  platform: MessengerPlatform;
  psid: string;
  display_name: string | null;
  contact_phone: string | null;
  status: "active" | "closed";
  last_user_message_at: string;
  created_at: string;
  updated_at: string;
};

export type MessengerMessageRole = "user" | "assistant" | "owner";

export type MessengerMessageRow = {
  id: number;
  conversation_id: string;
  business_id: string;
  role: MessengerMessageRole;
  content: string;
  mid: string | null;
  created_at: string;
};

export type MessengerJobRow = {
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

/** True when the conversation's 24h send window is still open. */
export function messengerWindowOpen(
  conversation: Pick<MessengerConversationRow, "last_user_message_at">,
  now: Date = new Date()
): boolean {
  const last = Date.parse(conversation.last_user_message_at);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last <= MESSENGER_WINDOW_MS;
}

/**
 * Find-or-create the conversation for an inbound message and bump its
 * 24h-window clock. `isNew` drives the first-contact AiFlow trigger.
 * Concurrent first messages race the insert; the unique identity index
 * makes one lose and we re-read the winner (webchat settings pattern).
 */
export async function upsertMessengerConversation(
  input: {
    businessId: string;
    pageId: string;
    platform: MessengerPlatform;
    psid: string;
    displayName?: string | null;
  },
  client?: SupabaseClient
): Promise<{ conversation: MessengerConversationRow; isNew: boolean }> {
  const db = client ?? (await createSupabaseServiceClient());
  const nowIso = new Date().toISOString();

  const existing = await getMessengerConversationByIdentity(input, db);
  if (existing) {
    const patch: Record<string, unknown> = {
      last_user_message_at: nowIso,
      updated_at: nowIso,
      status: "active"
    };
    if (input.displayName && !existing.display_name) {
      patch.display_name = input.displayName;
    }
    const { data, error } = await db
      .from("messenger_conversations")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw new Error(`upsertMessengerConversation: ${error.message}`);
    return { conversation: data as MessengerConversationRow, isNew: false };
  }

  const { data, error } = await db
    .from("messenger_conversations")
    .insert({
      business_id: input.businessId,
      page_id: input.pageId,
      platform: input.platform,
      psid: input.psid,
      display_name: input.displayName ?? null,
      last_user_message_at: nowIso
    })
    .select()
    .single();
  if (!error) {
    return { conversation: data as MessengerConversationRow, isNew: true };
  }
  // Insert race: the identity index made us lose — re-read the winner.
  const winner = await getMessengerConversationByIdentity(input, db);
  if (winner) return { conversation: winner, isNew: false };
  throw new Error(`upsertMessengerConversation: ${error.message}`);
}

async function getMessengerConversationByIdentity(
  input: { businessId: string; pageId: string; platform: MessengerPlatform; psid: string },
  db: SupabaseClient
): Promise<MessengerConversationRow | null> {
  const { data, error } = await db
    .from("messenger_conversations")
    .select("*")
    .eq("business_id", input.businessId)
    .eq("page_id", input.pageId)
    .eq("platform", input.platform)
    .eq("psid", input.psid)
    .maybeSingle();
  if (error) throw new Error(`getMessengerConversationByIdentity: ${error.message}`);
  return (data as MessengerConversationRow | null) ?? null;
}

export async function getMessengerConversationById(
  conversationId: string,
  client?: SupabaseClient
): Promise<MessengerConversationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("messenger_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`getMessengerConversationById: ${error.message}`);
  return (data as MessengerConversationRow | null) ?? null;
}

/**
 * Merge captured contact details onto the conversation. New NON-EMPTY
 * values win, missing fields leave the stored value alone (webchat
 * semantics).
 */
export async function updateMessengerConversationContact(
  conversationId: string,
  contact: { name?: string | null; phone?: string | null },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const patch: Record<string, string> = {};
  const name = contact.name?.trim();
  const phone = contact.phone?.trim();
  if (name) patch.display_name = name;
  if (phone) patch.contact_phone = phone;
  if (Object.keys(patch).length === 0) return;
  patch.updated_at = new Date().toISOString();
  const { error } = await db
    .from("messenger_conversations")
    .update(patch)
    .eq("id", conversationId);
  if (error) throw new Error(`updateMessengerConversationContact: ${error.message}`);
}

/** Conversation rows plus message counts, for the owner's Messenger list. */
export type MessengerConversationSummary = MessengerConversationRow & {
  message_count: number;
};

export async function listMessengerConversationsForBusiness(
  businessId: string,
  opts: { limit?: number } = {},
  client?: SupabaseClient
): Promise<MessengerConversationSummary[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? 50;
  const { data, error } = await db
    .from("messenger_conversations")
    .select("*, messenger_messages(count)")
    .eq("business_id", businessId)
    .order("last_user_message_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listMessengerConversationsForBusiness: ${error.message}`);
  type EmbeddedRow = MessengerConversationRow & {
    messenger_messages?: Array<{ count?: number }> | null;
  };
  return ((data as EmbeddedRow[] | null) ?? []).map((row) => {
    const { messenger_messages, ...rest } = row;
    const count = Array.isArray(messenger_messages)
      ? Number(messenger_messages[0]?.count ?? 0)
      : 0;
    return { ...rest, message_count: Number.isFinite(count) ? count : 0 };
  });
}

/**
 * Append a message. For inbound user messages, `mid` is Meta's message id
 * and the partial unique index dedupes webhook redeliveries — a duplicate
 * returns null so the caller skips enqueueing a second job.
 */
export async function appendMessengerMessage(
  input: {
    conversationId: string;
    businessId: string;
    role: MessengerMessageRole;
    content: string;
    mid?: string | null;
  },
  client?: SupabaseClient
): Promise<MessengerMessageRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("messenger_messages")
    .insert({
      conversation_id: input.conversationId,
      business_id: input.businessId,
      role: input.role,
      content: input.content,
      mid: input.mid ?? null
    })
    .select()
    .single();
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("23505") || msg.toLowerCase().includes("duplicate key")) {
      return null;
    }
    throw new Error(`appendMessengerMessage: ${error.message}`);
  }
  return data as MessengerMessageRow;
}

/**
 * Compensating delete for enqueue-failed paths (webchat's
 * deleteWebchatMessage rationale): a stored inbound message whose reply
 * job failed to insert is removed so the transcript never carries a
 * message no worker will ever answer — and a Meta redelivery can
 * re-ingest it cleanly past the mid dedupe.
 */
export async function deleteMessengerMessage(
  messageId: number,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("messenger_messages").delete().eq("id", messageId);
  if (error) throw new Error(`deleteMessengerMessage: ${error.message}`);
}

export async function listMessengerMessages(
  conversationId: string,
  opts: { limit?: number } = {},
  client?: SupabaseClient
): Promise<MessengerMessageRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? 200;
  const { data, error } = await db
    .from("messenger_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listMessengerMessages: ${error.message}`);
  // Newest-first fetch bounded the window; present oldest-first.
  return (((data as MessengerMessageRow[] | null) ?? [])).reverse();
}

export async function insertMessengerJob(
  input: { businessId: string; conversationId: string; userMessageId: number },
  client?: SupabaseClient
): Promise<MessengerJobRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("messenger_jobs")
    .insert({
      business_id: input.businessId,
      conversation_id: input.conversationId,
      user_message_id: input.userMessageId
    })
    .select()
    .single();
  if (error) throw new Error(`insertMessengerJob: ${error.message}`);
  return data as MessengerJobRow;
}

/** Atomic claim of the next queued job (any tenant); null when drained. */
export async function claimMessengerJob(
  workerId: string,
  client?: SupabaseClient
): Promise<MessengerJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("claim_messenger_job", {
    p_worker_id: workerId
  });
  if (error) throw new Error(`claimMessengerJob: ${error.message}`);
  const rows = (data as MessengerJobRow[] | null) ?? [];
  return rows[0] ?? null;
}

/**
 * Commit a reply atomically (assistant message + job done + supersede the
 * queued siblings the reply covered). Returns the assistant message id.
 */
export async function completeMessengerJob(
  jobId: string,
  content: string,
  historyMaxMessageId: number,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("messenger_job_complete", {
    p_job_id: jobId,
    p_content: content,
    p_history_max_message_id: historyMaxMessageId
  });
  if (error) throw new Error(`completeMessengerJob: ${error.message}`);
  const msgId = Number(data);
  if (!Number.isFinite(msgId)) {
    throw new Error(`completeMessengerJob: non-numeric message id ${String(data)}`);
  }
  return msgId;
}

/**
 * Flip a claimed job to error. Guarded to THIS claim generation
 * (claimed_at token) so a slow loser can never stamp 'error' over a turn
 * a reclaimer committed (webchat failWebchatJobFromPlatform rationale).
 */
export async function failMessengerJob(
  jobId: string,
  code: string,
  detail: string,
  claimedAt: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("messenger_jobs")
    .update({
      status: "error",
      error_code: code.slice(0, 100),
      error_detail: detail.slice(0, 500),
      completed_at: new Date().toISOString()
    })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("claimed_at", claimedAt);
  if (error) throw new Error(`failMessengerJob: ${error.message}`);
}

/**
 * Put a claimed job back in the queue after a TRANSIENT failure (Gemini
 * blip, Send API 5xx) so the next worker pass retries it promptly instead
 * of waiting for the 10-minute stale reclaim. Same claim-generation guard
 * as failMessengerJob; attempts already counted at claim, so the claim
 * RPC's `attempts < 3` bound still caps total tries.
 */
export async function requeueMessengerJob(
  jobId: string,
  claimedAt: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("messenger_jobs")
    .update({ status: "queued", claimed_by: null, claimed_at: null })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("claimed_at", claimedAt);
  if (error) throw new Error(`requeueMessengerJob: ${error.message}`);
}

/** Requeue wedged claims (>10 min); returns affected row count. */
export async function reclaimStaleMessengerJobs(
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("messenger_jobs_reclaim_stale");
  if (error) throw new Error(`reclaimStaleMessengerJobs: ${error.message}`);
  const count = Number(data);
  return Number.isFinite(count) ? count : 0;
}
