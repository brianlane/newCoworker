/**
 * Single-email body endpoint.
 *
 * GET /api/dashboard/emails/:id?businessId=<uuid> → { body_preview, body_full }
 *
 * The Emails list deliberately omits the full body (it loads up to 200 rows and
 * only needs the preview). The reading pane fetches the full body here when a
 * message is opened. Scoped by businessId + requireOwner so one tenant can
 * never read another's mail; admins bypass.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getEmailBody } from "@/lib/db/email-log";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({ businessId: z.string().uuid() });

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { id } = paramsSchema.parse(await ctx.params);
    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });

    if (!user.isAdmin) await requireOwner(businessId);

    const body = await getEmailBody(businessId, id);
    if (!body) return errorResponse("NOT_FOUND", "Email not found");

    return successResponse(body);
  } catch (err) {
    return handleRouteError(err);
  }
}
