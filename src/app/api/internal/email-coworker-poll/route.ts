/**
 * Internal endpoint that runs one email coworker pass.
 *
 * Kicked ~1/min by the ai-flow-worker Edge Function's cron tick, alongside
 * the AiFlow email/calendar trigger polls, for the same reason: the Nango
 * client and connection verification live in this Next.js runtime, not in
 * the worker. A pass is a cheap no-op for every business that owns no
 * active email thread.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`, same shape and
 * secret as the other /api/internal/* endpoints.
 *
 * Self-healing: the seen ledger makes repeat passes idempotent, and the
 * lookback window is much wider than the tick interval, so a failed or
 * skipped tick just means the reply is answered on a later one.
 */
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { pollEmailCoworker } from "@/lib/email-coworker/poll";

// A pass is a mailbox read plus (rarely) a model turn per new reply; the
// turns are the slow part, so this gets the same 60s ceiling as the
// AiFlow polls rather than the chat surfaces' 300s.
export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const result = await pollEmailCoworker();
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
