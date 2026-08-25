/**
 * Service-role data access for the Messenger/Instagram DM channel
 * (messenger_conversations / messenger_messages / messenger_jobs ,
 * migration 20260715201015_messenger_channel.sql).
 *
 * Every table is RLS-on/no-policies, so ALL access flows through here
 * after the caller's own auth: the Meta webhook route verifies the
 * X-Hub-Signature-256 first, the internal worker requires the cron
 * bearer, and the dashboard routes gate on requireBusinessRole: same
 * trust model as webchat/db.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type MessengerPlatform = "messenger" | "instagram" | "whatsapp";

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
  /** Sticky thread language for AI replies (en/es); null until known. */
  preferred_language?: "en" | "es" | null;
  last_user_message_at: string;
  /**
   * Click-to-Messenger / ig.me attribution as Meta sent it, stamped once on
   * the first referral seen for the thread.
   */
  referral?: Record<string, unknown> | null;
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
  delivery_status?: MessengerDeliveryStatus | null;
  delivery_error_code?: string | null;
  delivery_error_title?: string | null;
  delivery_updated_at?: string | null;
};

/**
 * Meta's receipt states for an outbound message. `failed` is terminal and
 * carries an error code; the other three are a strict progression.
 */
export type MessengerDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/**
 * Receipts arrive out of order (a `delivered` webhook can land before the
 * `sent` one for the same message), so a raw last-write-wins update would
 * report a delivered message as merely sent. Rank orders the progression
 * and the writer refuses to move backwards.
 *
 * `failed` sits at the top because it is terminal and is the state the
 * whole feature exists to surface: it must never be masked by a `sent`
 * receipt that was already in flight when the send failed.
 */
const DELIVERY_STATUS_RANK: Record<MessengerDeliveryStatus, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4
};

/** The same states as a list, for building the update's rank predicate. */
const DELIVERY_STATUS_ORDER = Object.keys(DELIVERY_STATUS_RANK) as MessengerDeliveryStatus[];

export function deliveryStatusOutranks(
  next: MessengerDeliveryStatus,
  current: MessengerDeliveryStatus | null | undefined
): boolean {
  if (!current) return true;
  return DELIVERY_STATUS_RANK[next] > DELIVERY_STATUS_RANK[current];
}

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
  // Insert race: the identity index made us lose: re-read the winner.
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

/**
 * Side-effect-free identity lookup for OUTBOUND paths (the WhatsApp
 * deliver helper's 24h-window read): unlike upsertMessengerConversation
 * it never bumps the window clock.
 */
export async function getMessengerConversationByIdentityPublic(
  businessId: string,
  pageId: string,
  platform: MessengerPlatform,
  psid: string,
  client?: SupabaseClient
): Promise<MessengerConversationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  return getMessengerConversationByIdentity({ businessId, pageId, platform, psid }, db);
}

/**
 * Conversation row for a BUSINESS-INITIATED thread (outbound WhatsApp to
 * a contact who never messaged first). last_user_message_at is backdated
 * to epoch so the fresh row reads as a CLOSED 24h window: only a real
 * inbound message (upsertMessengerConversation) opens it. Races re-read
 * the winner.
 */
export async function insertOutboundMessengerConversation(
  input: {
    businessId: string;
    pageId: string;
    platform: MessengerPlatform;
    psid: string;
  },
  client?: SupabaseClient
): Promise<MessengerConversationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("messenger_conversations")
    .insert({
      business_id: input.businessId,
      page_id: input.pageId,
      platform: input.platform,
      psid: input.psid,
      last_user_message_at: new Date(0).toISOString()
    })
    .select()
    .single();
  if (!error) return data as MessengerConversationRow;
  const winner = await getMessengerConversationByIdentity(input, db);
  if (winner) return winner;
  throw new Error(`insertOutboundMessengerConversation: ${error.message}`);
}

/**
 * Persist the detected thread language so later turns (and the SMS bridge,
 * once a phone is captured) stay sticky. Detection-only writes: there is no
 * owner override at the conversation level (that lives on contacts).
 */
/**
 * The thread for one person on one platform, without needing the page id.
 * A Page-side echo names the account and the recipient but not the page the
 * conversation was filed under, and a business has one thread per person per
 * platform, so this is unambiguous.
 */
export async function findMessengerConversation(
  businessId: string,
  platform: MessengerPlatform,
  psid: string,
  client?: SupabaseClient
): Promise<MessengerConversationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("messenger_conversations")
    .select()
    .eq("business_id", businessId)
    .eq("platform", platform)
    .eq("psid", psid)
    .maybeSingle();
  if (error) throw new Error(`findMessengerConversation: ${error.message}`);
  return (data as MessengerConversationRow | null) ?? null;
}

/**
 * Stamp ad attribution, ONCE. Guarded on the column still being null so the
 * referral that started the conversation wins over any later re-entry from a
 * different ad. Returns whether this call was the one that stamped it.
 */
export async function setMessengerConversationReferral(
  conversationId: string,
  referral: Record<string, unknown>,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("messenger_conversations")
    .update({ referral, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .is("referral", null)
    .select("id");
  if (error) throw new Error(`setMessengerConversationReferral: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function setMessengerConversationLanguage(
  conversationId: string,
  language: "en" | "es",
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("messenger_conversations")
    .update({ preferred_language: language })
    .eq("id", conversationId);
  if (error) throw new Error(`setMessengerConversationLanguage: ${error.message}`);
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
  opts: { limit?: number; platform?: MessengerPlatform } = {},
  client?: SupabaseClient
): Promise<MessengerConversationSummary[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const limit = opts.limit ?? 50;
  let query = db
    .from("messenger_conversations")
    .select("*, messenger_messages(count)")
    .eq("business_id", businessId);
  if (opts.platform) query = query.eq("platform", opts.platform);
  const { data, error } = await query
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
 * and the partial unique index dedupes webhook redeliveries: a duplicate
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
 * Apply a Meta delivery receipt to the outbound row it belongs to, keyed by
 * the wamid the send stored. Returns what happened so the caller can log a
 * failed delivery loudly and stay quiet about the routine ones.
 *
 * `not_found` is expected and benign: Meta also sends receipts for messages
 * this system did not write (a human replying from the Meta inbox), and for
 * anything sent before the wamid was persisted.
 */
export async function applyMessengerDeliveryStatus(
  input: {
    businessId: string;
    mid: string;
    status: MessengerDeliveryStatus;
    errorCode?: string | null;
    errorTitle?: string | null;
    timestamp?: string | null;
  },
  client?: SupabaseClient
): Promise<"applied" | "stale" | "not_found"> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("messenger_messages")
    .select("id, delivery_status")
    .eq("business_id", input.businessId)
    .eq("mid", input.mid)
    .maybeSingle();
  if (readError) throw new Error(`applyMessengerDeliveryStatus: ${readError.message}`);
  if (!existing) return "not_found";
  const row = existing as { id: number; delivery_status: MessengerDeliveryStatus | null };
  // Fast path only: skips a pointless write. It is NOT what makes the
  // ordering safe, because the row can change between this read and the
  // update below. The predicate on the update is what actually enforces it.
  if (!deliveryStatusOutranks(input.status, row.delivery_status)) return "stale";

  // Meta fires sent/delivered/read within milliseconds of each other, and
  // separate webhook POSTs run as separate concurrent invocations. Two of
  // them reading the same snapshot would both pass the check above, and
  // last-write-wins could then drop a `delivered` back to `sent`, or worse
  // bury a `failed`. Re-checking the rank in the UPDATE's own WHERE clause
  // closes that: Postgres evaluates it under the row lock, so the loser of
  // a race matches zero rows instead of overwriting the winner.
  const outranked = DELIVERY_STATUS_ORDER.filter(
    (candidate) => DELIVERY_STATUS_RANK[candidate] < DELIVERY_STATUS_RANK[input.status]
  );
  const rankGuard =
    outranked.length > 0
      ? `delivery_status.is.null,delivery_status.in.(${outranked.join(",")})`
      : "delivery_status.is.null";

  const { data: updated, error } = await db
    .from("messenger_messages")
    .update({
      delivery_status: input.status,
      // Only a failure carries these, and a later failure must be able to
      // replace an earlier one's code rather than append to it.
      delivery_error_code: input.status === "failed" ? (input.errorCode ?? null) : null,
      delivery_error_title: input.status === "failed" ? (input.errorTitle ?? null) : null,
      delivery_updated_at: input.timestamp ?? new Date().toISOString()
    })
    .eq("id", row.id)
    .or(rankGuard)
    // A PostgREST update matching zero rows is NOT an error, so the returned
    // rows are the only way to tell "written" from "lost the race".
    .select("id");
  if (error) throw new Error(`applyMessengerDeliveryStatus: ${error.message}`);
  return (updated ?? []).length > 0 ? "applied" : "stale";
}

/**
 * Compensating delete for enqueue-failed paths (webchat's
 * deleteWebchatMessage rationale): a stored inbound message whose reply
 * job failed to insert is removed so the transcript never carries a
 * message no worker will ever answer: and a Meta redelivery can
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
