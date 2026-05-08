/**
 * Read/write helpers for the `dashboard_chat_jobs` table that backs the
 * VPS-side chat worker (Option B). The Vercel route inserts a `queued`
 * job; the worker on the per-tenant VPS claims it via
 * `claim_chat_job()`, calls Rowboat, persists the assistant message,
 * and marks the job `done`. The browser subscribes to
 * `dashboard_chat_messages` Realtime to render the reply when it lands.
 *
 * See:
 *   - supabase/migrations/20260508000000_dashboard_chat_jobs.sql
 *   - vps/chat-worker/worker.mjs
 *
 * Access is service-role only; all callers MUST gate on requireOwner()
 * before invoking — same trust model as the rest of dashboard-chat.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { DashboardChatRole } from "@/lib/db/dashboard-chat";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type DashboardChatJobStatus = "queued" | "processing" | "done" | "error";

/**
 * One pre-built Rowboat input message. The Vercel route assembles the
 * full list (system preambles + summary + history tail + new user turn)
 * and stores it on the job row so the worker has zero business logic
 * to duplicate. Schema MUST match what `callRowboat` in the worker
 * forwards to `/api/v1/{projectId}/chat`.
 */
export type DashboardChatJobInputMessage = {
  role: DashboardChatRole;
  content: string;
};

export type DashboardChatJobRow = {
  id: string;
  business_id: string;
  thread_id: string;
  user_message_id: number;
  status: DashboardChatJobStatus;
  attempts: number;
  claimed_by: string | null;
  claimed_at: string | null;
  assistant_message_id: number | null;
  input_messages: DashboardChatJobInputMessage[] | null;
  /**
   * Stateless-retry fallback input. Non-null only when the first-attempt
   * input was a continuation call (Rowboat's server-side state expected
   * to fill in the conversation tail). On a STATELESS_RETRY_ERRORS-class
   * failure the worker re-invokes Rowboat with THIS variant — which
   * already includes the tail as a system message — and WITHOUT a
   * conversationId, so the call succeeds entirely off our local prompt.
   * Null on fresh-thread jobs where the first-attempt input is already
   * stateless (no fallback escalation makes sense).
   */
  stateless_input_messages: DashboardChatJobInputMessage[] | null;
  rowboat_conversation_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/**
 * Insert a fresh `queued` job. Returns the new row so the caller can
 * surface the `id` to the client (the client uses it to subscribe to
 * status updates as a fallback when Realtime can't deliver the
 * assistant message INSERT for some reason).
 *
 * Idempotency: callers MUST pass a fresh `userMessageId` per turn.
 * Re-using the same `userMessageId` for a second job would create a
 * duplicate worker run — there's no unique index on `user_message_id`
 * (deliberately, to keep stateless retries cheap if the route ever
 * needs them) so the schema doesn't catch that mistake.
 */
export async function insertChatJob(
  args: {
    businessId: string;
    threadId: string;
    userMessageId: number;
    inputMessages: DashboardChatJobInputMessage[];
    /**
     * Stateless-retry fallback input. Pass null when the first-attempt
     * input is ALREADY stateless (fresh thread, no continuation) — the
     * worker treats null as "no fallback path" and any error from the
     * single attempt is final.
     */
    statelessInputMessages: DashboardChatJobInputMessage[] | null;
    rowboatConversationId: string | null;
  },
  client?: SupabaseClient
): Promise<DashboardChatJobRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("dashboard_chat_jobs")
    .insert({
      business_id: args.businessId,
      thread_id: args.threadId,
      user_message_id: args.userMessageId,
      input_messages: args.inputMessages,
      stateless_input_messages: args.statelessInputMessages,
      rowboat_conversation_id: args.rowboatConversationId
    })
    .select("*")
    .single();
  if (error) throw new Error(`insertChatJob: ${error.message}`);
  return data as DashboardChatJobRow;
}

/**
 * Fetch a single job row by id. Used by the polling-fallback endpoint
 * and by tests. Returns null when the id doesn't exist (job ids are
 * UUIDs so a guess is computationally infeasible, but a caller might
 * pass a stale id from a previous session).
 */
export async function getChatJobById(
  jobId: string,
  client?: SupabaseClient
): Promise<DashboardChatJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("dashboard_chat_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`getChatJobById: ${error.message}`);
  return (data as DashboardChatJobRow | null) ?? null;
}

/**
 * Project the worker-internal job row to the JSON envelope returned to
 * the browser. We deliberately drop:
 *   - claimed_by / claimed_at        (worker-internal accounting)
 *   - input_messages                 (already shown to the user as their
 *                                      typed message + system preambles
 *                                      that the user shouldn't see)
 *   - stateless_input_messages       (worker-internal fallback variant;
 *                                      contains the same content the
 *                                      user already sees inline)
 *   - rowboat_conversation_id        (Rowboat-internal)
 *   - attempts                       (worker-internal)
 *
 * What survives is the minimum the client needs to render "thinking…"
 * vs "done" vs "error", and on error to surface a friendly message.
 */
export function serializeChatJobStatus(row: DashboardChatJobRow) {
  return {
    id: row.id,
    threadId: row.thread_id,
    userMessageId: row.user_message_id,
    status: row.status,
    assistantMessageId: row.assistant_message_id,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}
