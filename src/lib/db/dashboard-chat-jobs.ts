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
  /**
   * Rowboat client-carried state for the first attempt. Null on fresh
   * threads (Rowboat hasn't issued state yet) and on rows where the
   * previous turn's state was invalidated by a stateless retry.
   * Worker forwards this to Rowboat with the conversationId; the
   * updated state from Rowboat's response is persisted back to
   * dashboard_chat_threads.rowboat_state.
   */
  rowboat_state: unknown | null;
  /**
   * Rowboat startAgent override for this job: "OwnerCoworker" (Gemini) on the
   * normal path, "OwnerCoworkerLocal" (Qwen) once the per-period owner-chat
   * spend cap is reached. Null = the worker uses its CHAT_WORKER_OWNER_START_AGENT
   * env default (backwards compatible with pre-spend-cap rows).
   */
  start_agent: string | null;
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
    /**
     * Rowboat client-carried state from the previous turn. Pass null
     * when there is none to forward (fresh thread / cleared by a
     * prior stateless retry).
     */
    rowboatState: unknown | null;
    /**
     * Rowboat startAgent override for this job (spend-cap routing). Pass null
     * to let the worker use its env default. See {@link DashboardChatJobRow.start_agent}.
     */
    startAgent?: string | null;
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
      rowboat_conversation_id: args.rowboatConversationId,
      rowboat_state: args.rowboatState,
      start_agent: args.startAgent ?? null
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
 * How recent an in-flight (`queued`/`processing`) job must be to count as
 * "the owner is still waiting on this reply" when hydrating the chat UI.
 *
 * Sized just above the worker's absolute worst case (primary attempt +
 * stateless retry = 2 × WORKER_ROWBOAT_TIMEOUT_MS (240s) + DB headroom).
 * A job older than this that's STILL `queued`/`processing` is almost
 * certainly orphaned (worker was down — see the May 11 Realtime/Supabase
 * incident) and reclaim_stale_chat_jobs() will eventually flip or error
 * it; we don't want such a corpse to render a permanent "thinking…"
 * indicator on every page load.
 */
export const IN_FLIGHT_CHAT_JOB_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Latest still-running job for a thread, used to re-attach the
 * "your coworker is thinking…" indicator after a refresh / navigation.
 *
 * Only `queued`/`processing` rows newer than {@link IN_FLIGHT_CHAT_JOB_MAX_AGE_MS}
 * qualify — see that constant for why stale rows are excluded. Returns the
 * newest match (a thread should only ever have one live job, but ordering
 * newest-first is belt-and-suspenders if a reclaim race ever leaves two).
 */
export async function getInFlightChatJobForThread(
  threadId: string,
  client?: SupabaseClient
): Promise<DashboardChatJobRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const freshSince = new Date(Date.now() - IN_FLIGHT_CHAT_JOB_MAX_AGE_MS).toISOString();
  const { data, error } = await db
    .from("dashboard_chat_jobs")
    .select("*")
    .eq("thread_id", threadId)
    .in("status", ["queued", "processing"])
    .gte("created_at", freshSince)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getInFlightChatJobForThread: ${error.message}`);
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
