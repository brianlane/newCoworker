/**
 * Per-user dismissal of dashboard promo cards (the AiFlows starter
 * installers). Scoped to the SIGNED-IN auth user, like the sidebar layout: no
 * business role is involved, and an impersonating admin hides the card on
 * their own dashboard, never the tenant's.
 */
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { dismissCard, listDismissedCardKeys } from "@/lib/dashboard/dismissed-cards";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ cardKey: z.string().min(1).max(64) });

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    try {
      await dismissCard(user.userId, body.cardKey);
    } catch (err) {
      // An unknown key is a caller error, not a 500.
      if (err instanceof Error && /unknown card key/.test(err.message)) {
        return errorResponse("VALIDATION_ERROR", err.message);
      }
      throw err;
    }
    return successResponse({ dismissed: await listDismissedCardKeys(user.userId) });
  } catch (err) {
    return handleRouteError(err);
  }
}
