/**
 * Shared "stop this lead's automations" core, revision-gated cancels for
 * every pending AiFlow run matched to a lead's identity set. Used by BOTH
 * owner intents:
 *   - flag_contact_spam ("he's spam"), canceledBy "owner_declared_spam";
 *   - set_contact_reply_mode suppress ("stop texting Chris"), canceledBy
 *     "owner_stopped_texting" (the Chris Gregoris incident, Jul 24 2026:
 *     the ONLY tool that could stop follow-ups was the irreversible spam
 *     block, so the model used it on a hot lead).
 *
 * Best-effort by contract: callers apply their own load-bearing suppression
 * (opt-out / reply mode) FIRST, so a missed cancel here can only leave a
 * stale-looking run, never an unwanted text (spam callers) or an unwanted
 * default reply (reply-mode callers).
 */

import type { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/**
 * Every non-terminal run state, human-parked AND `running` included (an
 * owner stop means stop). Matches the dashboard owner-stop's
 * CANCELABLE_RUN_STATUSES: a `running` run cancels cooperatively, the
 * worker re-reads status at each step boundary and quits when it sees
 * canceled.
 */
export const LEAD_STOPPABLE_STATUSES = [
  "queued",
  "running",
  "awaiting_reply",
  "awaiting_call",
  "awaiting_approval",
  "awaiting_agent"
] as const;

/** Most runs one stop will cancel (same bound as the goal jumps). */
const MAX_RUNS_PER_STOP = 25;

type PendingRun = {
  id: string;
  status: string;
  context: Record<string, unknown> | null;
  revision: number;
};

export type CancelLeadRunsResult = {
  canceledRuns: number;
  /** False = a lookup/write error left the sweep unconfirmed. */
  sweepComplete: boolean;
};

/**
 * Cancel every pending run matched to any number in the lead's identity set,
 * with the owner-stop shape (`status: canceled` + `context.canceled` audit)
 * so the runs page renders it natively. Same lead-identity keys the goal
 * jumps / stop-on-response use. Never throws.
 */
export async function cancelPendingRunsForLead(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string,
  numbers: string[],
  canceledBy: string
): Promise<CancelLeadRunsResult> {
  let canceledRuns = 0;
  let sweepComplete = true;

  const runMatchOr = numbers
    .flatMap((n) => [
      `context->trigger->>from.eq.${n}`,
      `context->vars->>lead_phone.eq.${n}`,
      `context->waiting_reply->>from.eq.${n}`,
      `context->waiting_call->>to.eq.${n}`
    ])
    .join(",");
  const { data: runRows, error: runsErr } = await db
    .from("ai_flow_runs")
    .select("id, status, context, revision")
    .eq("business_id", businessId)
    .in("status", [...LEAD_STOPPABLE_STATUSES])
    .or(runMatchOr)
    .limit(MAX_RUNS_PER_STOP);
  if (runsErr) {
    logger.error("cancelPendingRunsForLead: pending-run lookup failed", {
      businessId,
      error: runsErr.message
    });
    return { canceledRuns: 0, sweepComplete: false };
  }

  for (const run of (runRows ?? []) as PendingRun[]) {
    const nextContext = {
      ...(run.context ?? {}),
      canceled: {
        by: canceledBy,
        at: new Date().toISOString(),
        from_status: run.status
      }
    };
    // Optimistic concurrency, same shape as stop-on-response: gate on the
    // revision we read so a concurrent claim/resume wins cleanly (the
    // caller's suppression still governs whatever that run tries next).
    const { data: updated, error: updErr } = await db
      .from("ai_flow_runs")
      .update({
        status: "canceled",
        context: nextContext,
        claimed_at: null,
        respond_by_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id)
      .eq("revision", run.revision)
      .in("status", [...LEAD_STOPPABLE_STATUSES])
      .select("id");
    if (updErr) {
      logger.error("cancelPendingRunsForLead: run cancel failed", {
        businessId,
        runId: run.id,
        error: updErr.message
      });
      sweepComplete = false;
      continue;
    }
    if (((updated ?? []) as unknown[]).length > 0) canceledRuns += 1;
  }
  return { canceledRuns, sweepComplete };
}
