/**
 * GET /api/widget/poll — reply delivery for the website chat widget.
 *
 * The widget calls this ONLY while a job is in flight AND the tab is
 * visible (see public/widget frame JS), with backoff — there is no
 * standing poll loop. Anonymous visitors can't use Supabase Realtime
 * (deny-by-default RLS), so this is the delivery path.
 *
 * Query: key, jobId (optional), after (message-id cursor, 0 for none).
 * Without a jobId this is a plain history read — the frame uses it to
 * re-hydrate the transcript when a returning visitor reopens the widget.
 * Auth: public site key + per-session bearer; the job must belong to the
 * bearer's session, so one visitor can never watch another's turn.
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  getWebchatJobById,
  listWebchatMessagesSince,
  serializeWebchatMessages
} from "@/lib/webchat/db";
import { resolveWidgetContext, verifyWebchatSession } from "@/lib/webchat/service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  key: z.string().max(200),
  jobId: z.string().uuid().optional(),
  after: z.coerce.number().int().min(0).default(0)
});

/** Visitor-facing copy for a failed turn — never the raw error taxonomy. */
const JOB_ERROR_MESSAGE =
  "Sorry — I couldn't get a reply just now. Please try sending that again.";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = querySchema.parse({
      key: url.searchParams.get("key") ?? "",
      jobId: url.searchParams.get("jobId") ?? undefined,
      after: url.searchParams.get("after") ?? "0"
    });

    const ctx = await resolveWidgetContext({ key: query.key });
    if (!ctx.ok) {
      if (ctx.reason === "offline") {
        return errorResponse("CONFLICT", "Chat is offline right now.");
      }
      return errorResponse("UNAUTHORIZED", "This chat widget is not available.");
    }

    const session = await verifyWebchatSession({
      authorizationHeader: request.headers.get("authorization"),
      businessId: ctx.business.id
    });
    if (!session) {
      return errorResponse("UNAUTHORIZED", "Chat session expired. Please start a new chat.");
    }

    let jobStatus: string | null = null;
    if (query.jobId) {
      const job = await getWebchatJobById(query.jobId);
      if (!job || job.session_id !== session.id) {
        // Same response for "not yours" and "doesn't exist".
        return errorResponse("NOT_FOUND", "Unknown chat turn.");
      }
      jobStatus = job.status;
    }

    const messages = await listWebchatMessagesSince(session.id, query.after);

    return successResponse({
      status: jobStatus,
      errorMessage: jobStatus === "error" ? JOB_ERROR_MESSAGE : null,
      messages: serializeWebchatMessages(messages)
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
