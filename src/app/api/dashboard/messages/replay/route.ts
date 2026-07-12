/**
 * SMS-replay backfill endpoint (Texts page "Replay missed texts").
 *
 * POST /api/dashboard/messages/replay?businessId=<uuid>
 *   body: { flowId, lookbackHours }
 *   → { summary }
 *
 * Re-runs recent inbound texts through the chosen SMS-triggered flow as
 * BACKFILL runs: each text is re-evaluated against the flow's trigger
 * conditions exactly like the live inbound path would have (correlation
 * windows included), matches enqueue with the live dedupe key (never
 * double-fires a message the webhook already handled), and the worker files
 * brand-new leads while ending runs for already-saved contacts without any
 * outreach — a replay can never double-text.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_aiflows")
 * (admins bypass, same convention as the email replay route). The target
 * flow must exist for this business, be enabled, carry an SMS trigger, and
 * file the lead before any outreach step.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getAiFlow } from "@/lib/ai-flows/db";
import { flowUpsertsBeforeOutreach } from "@/lib/email/replay";
import {
  MAX_REPLAY_LOOKBACK_HOURS,
  flowHasSmsTrigger,
  replayInboundSms
} from "@/lib/sms/replay";

export const dynamic = "force-dynamic";
// Each matched text is one enqueue round trip; a full batch stays well under
// this, but don't let a slow Supabase day 504 a big replay.
export const maxDuration = 120;

const REPLAY_RATE = { interval: 60 * 1000, maxRequests: 10 };

const querySchema = z.object({ businessId: z.string().uuid() });

const bodySchema = z.object({
  flowId: z.string().uuid(),
  lookbackHours: z.number().int().min(1).max(MAX_REPLAY_LOOKBACK_HOURS)
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_aiflows");

    const limiter = rateLimit(`sms-replay:${businessId}`, REPLAY_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many replays, slow down.", 429);
    }

    const raw = (await request.json().catch(() => null)) as unknown;
    const body = bodySchema.parse(raw);

    const flow = await getAiFlow(businessId, body.flowId);
    if (!flow) return errorResponse("NOT_FOUND", "Flow not found", 404);
    if (!flow.enabled) {
      return errorResponse("VALIDATION_ERROR", "Enable the flow before replaying texts into it.");
    }
    if (!flowHasSmsTrigger(flow.definition)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This flow doesn't start from an inbound text, so it can't replay texts."
      );
    }
    // The no-double-text guarantee lives in the worker's upsert_customer
    // step: a backfill run halts there when the lead is already a contact.
    // A flow that texts BEFORE filing the lead (or never files it) can't be
    // protected, so it isn't a valid replay target.
    if (!flowUpsertsBeforeOutreach(flow.definition)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This flow reaches out before saving the lead as a contact, so a replay can't guarantee " +
          "already-contacted leads won't be texted again. Add a 'Save customer' step before the " +
          "first message and try again."
      );
    }

    const summary = await replayInboundSms(
      businessId,
      { id: flow.id, definition: flow.definition },
      { lookbackHours: body.lookbackHours }
    );
    return successResponse({ summary });
  } catch (err) {
    return handleRouteError(err);
  }
}
