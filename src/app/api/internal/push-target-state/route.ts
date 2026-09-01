/**
 * Internal push target-state: the bridge the Deno notification mirror calls
 * BEFORE it decides whether to suppress SMS for `push_replaces_sms`.
 *
 * Eligibility (a real roster role, not a leftover HQ view-as row) lives in
 * `src/lib/push`, which an edge function cannot import. Asking here keeps
 * one implementation for deliverable. Deno still answers connected from a
 * local existence check so a never-subscribed tenant stays silent when
 * this route is unreachable. An unfiltered live-row check for deliverable
 * would treat a leaked admin device as able to suppress SMS, then
 * `deliverPush` would drop that row and the owner would get neither channel.
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth).
 *
 * POST { businessId: uuid }
 * → 200 `{ connected, deliverable }`. Failures of the helper itself are
 * already encoded in those flags (connected true / deliverable false), so
 * they are not HTTP errors.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { pushTargetState } from "@/lib/push/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    const state = await pushTargetState(body.businessId);
    return successResponse(state);
  } catch (err) {
    return handleRouteError(err);
  }
}
