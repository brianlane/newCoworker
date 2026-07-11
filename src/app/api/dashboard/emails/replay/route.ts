/**
 * Email-replay backfill endpoint (Emails page "Replay through flow").
 *
 * POST /api/dashboard/emails/replay?businessId=<uuid>
 *   body: { flowId, emailLogIds: string[] }
 *   → { summary }
 *
 * Re-runs inbound AI-mailbox emails that never matched a flow (typically
 * because the flow was disabled when they arrived) through the chosen
 * tenant_email flow, as BACKFILL runs: the worker files brand-new leads and
 * runs the full flow for them, but ends the run without outreach when the
 * lead already exists as a contact — a replay can never double-text.
 *
 * Auth: getAuthUser + requireBusinessRole(businessId, "manage_aiflows")
 * (admins bypass, same convention as the lead-import route). The target flow
 * must exist for this business, be enabled, and carry a tenant_email trigger.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { getAiFlow } from "@/lib/ai-flows/db";
import {
  MAX_REPLAY_EMAILS,
  flowHasTenantEmailTrigger,
  flowUpsertsBeforeOutreach,
  replayInboundEmails
} from "@/lib/email/replay";

export const dynamic = "force-dynamic";
// Each replayed email is one enqueue round trip; a full batch stays well
// under this, but don't let a slow Supabase day 504 a big replay.
export const maxDuration = 120;

const REPLAY_RATE = { interval: 60 * 1000, maxRequests: 10 };

const querySchema = z.object({ businessId: z.string().uuid() });

const bodySchema = z.object({
  flowId: z.string().uuid(),
  emailLogIds: z.array(z.string().uuid()).min(1).max(MAX_REPLAY_EMAILS)
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

    const limiter = rateLimit(`email-replay:${businessId}`, REPLAY_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many replays, slow down.", 429);
    }

    const raw = (await request.json().catch(() => null)) as unknown;
    const body = bodySchema.parse(raw);

    // Same gating shape as the lead-import target flow: it must exist for
    // THIS business and be enabled — and here it must actually read the AI
    // mailbox, or every replayed run would just fail confusingly.
    const flow = await getAiFlow(businessId, body.flowId);
    if (!flow) return errorResponse("NOT_FOUND", "Flow not found", 404);
    if (!flow.enabled) {
      return errorResponse("VALIDATION_ERROR", "Enable the flow before replaying emails into it.");
    }
    if (!flowHasTenantEmailTrigger(flow.definition)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "This flow doesn't start from the AI email inbox, so it can't replay inbox emails."
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

    const summary = await replayInboundEmails(
      businessId,
      { id: flow.id, definition: flow.definition },
      { emailLogIds: body.emailLogIds }
    );
    return successResponse({ summary });
  } catch (err) {
    return handleRouteError(err);
  }
}
