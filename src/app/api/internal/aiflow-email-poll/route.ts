/**
 * Internal endpoint that runs one inbound-email trigger poll.
 *
 * Kicked ~1/min by the ai-flow-worker Edge Function's cron tick (the worker
 * can't poll mailboxes itself — the Nango client + connection verification
 * live in this Next.js runtime). Reads recent inbox messages for every
 * mailbox watched by an enabled email-triggered flow and enqueues matching
 * ai_flow_runs; the worker then claims those on its next tick like any other
 * queued run.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` — same shape and
 * secret as the other /api/internal/* endpoints.
 *
 * Self-healing: dedupe keys make repeat polls idempotent, so a failed or
 * skipped tick just means the message is picked up on the next one (the
 * lookback window is much wider than the poll interval).
 */
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { pollEmailTriggers } from "@/lib/ai-flows/email-poll";

// A poll is a few provider list/read calls per watched mailbox; 60s is ample
// headroom without letting a hung provider pin the function.
export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await pollEmailTriggers();
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
