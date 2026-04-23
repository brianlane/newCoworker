/**
 * Owner ↔ local-model chat persistence (/dashboard/chat).
 *
 * We store at most one *active* thread per business; "New conversation" in the
 * UI flips the active flag to false so the next POST creates a fresh one.
 * Access is service-role only; all callers must gate on requireOwner() first.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type DashboardChatRole = "user" | "assistant" | "system";

export type DashboardChatThreadRow = {
  id: string;
  business_id: string;
  rowboat_conversation_id: string | null;
  rowboat_state: unknown | null;
  title: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DashboardChatMessageRow = {
  id: number;
  thread_id: string;
  role: DashboardChatRole;
  content: string;
  created_at: string;
};

export async function getActiveThread(
  businessId: string,
  client?: SupabaseClient
): Promise<DashboardChatThreadRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("dashboard_chat_threads")
    .select("*")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveThread: ${error.message}`);
  return (data as DashboardChatThreadRow | null) ?? null;
}

export async function createThread(
  businessId: string,
  title: string | null,
  client?: SupabaseClient
): Promise<DashboardChatThreadRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("dashboard_chat_threads")
    .insert({
      business_id: businessId,
      title: title ? title.slice(0, 140) : null,
      is_active: true
    })
    .select()
    .single();
  if (error) throw new Error(`createThread: ${error.message}`);
  return data as DashboardChatThreadRow;
}

/** Postgres unique-violation SQLSTATE; thrown when two requests race to
 * create the single active thread allowed by
 * `dashboard_chat_threads_one_active` (partial unique index on business_id
 * where is_active). */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  return (
    msg.includes(PG_UNIQUE_VIOLATION) ||
    msg.toLowerCase().includes("duplicate key") ||
    msg.toLowerCase().includes("one_active")
  );
}

/**
 * Get the active thread or create a fresh one in a single round-trip intent.
 *
 * Race-safety: the migration adds a partial unique index so only one active
 * thread per business can exist. Two concurrent first-message POSTs can both
 * see "no active thread" and race the insert — one wins, one fails with
 * 23505. We swallow that and re-read the winner's row instead of bubbling up
 * a spurious 500.
 */
export async function getOrCreateActiveThread(
  businessId: string,
  titleForNew: string | null,
  client?: SupabaseClient
): Promise<DashboardChatThreadRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const existing = await getActiveThread(businessId, db);
  if (existing) return existing;
  try {
    return await createThread(businessId, titleForNew, db);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await getActiveThread(businessId, db);
    if (winner) return winner;
    // Extremely unlikely: unique violation without a winner row (e.g. the
    // winner was immediately deactivated). Surface the original error rather
    // than loop forever.
    throw err;
  }
}

export async function appendMessage(
  threadId: string,
  role: DashboardChatRole,
  content: string,
  client?: SupabaseClient
): Promise<DashboardChatMessageRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("dashboard_chat_messages")
    .insert({ thread_id: threadId, role, content })
    .select()
    .single();
  if (error) throw new Error(`appendMessage: ${error.message}`);
  // Touch the thread so `updated_at` reflects latest activity.
  await db
    .from("dashboard_chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);
  return data as DashboardChatMessageRow;
}

export async function listMessages(
  threadId: string,
  client?: SupabaseClient
): Promise<DashboardChatMessageRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("dashboard_chat_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listMessages: ${error.message}`);
  return (data as DashboardChatMessageRow[] | null) ?? [];
}

export async function updateThreadConversation(
  threadId: string,
  conversationId: string | null,
  state: unknown,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };
  if (conversationId !== null) update.rowboat_conversation_id = conversationId;
  // Only write state when we actually have one. Rowboat may respond without a
  // state key between turns; preserving the prior value is the desired default.
  if (state !== undefined) update.rowboat_state = state;
  const { error } = await db
    .from("dashboard_chat_threads")
    .update(update)
    .eq("id", threadId);
  if (error) throw new Error(`updateThreadConversation: ${error.message}`);
}

/** Flip the current active thread to inactive so the next POST makes a new one. */
export async function deactivateActiveThread(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("dashboard_chat_threads")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (error) throw new Error(`deactivateActiveThread: ${error.message}`);
}

/**
 * Upsert the last-owner-chat timestamp. Read from the VPS keep-warm script so
 * it can stand down while the owner is actively chatting.
 */
export async function touchChatActivity(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const nowIso = new Date().toISOString();
  const { error } = await db
    .from("dashboard_chat_activity")
    .upsert(
      { business_id: businessId, last_user_chat_at: nowIso, updated_at: nowIso },
      { onConflict: "business_id" }
    );
  if (error) throw new Error(`touchChatActivity: ${error.message}`);
}
