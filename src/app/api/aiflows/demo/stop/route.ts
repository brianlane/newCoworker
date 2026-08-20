/**
 * End a browse-step demonstration session. Idempotent: stopping a session
 * that already expired (or died with its box) is success, because the goal
 * state ("no live session") holds either way.
 *
 * POST { businessId, demoId } -> { ok: true, actionsCount? }
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { stopBrowseDemo, type DemoStopFailure } from "@/lib/ai-flows/demo-session";
import { recordSystemLog } from "@/lib/db/system-logs";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  demoId: z.string().uuid()
});

/**
 * Keyed on the exported union, so a new failure mode in the lib is a compile
 * error here rather than the word "undefined" reaching an owner.
 */
const FAILURE_MESSAGES: Record<DemoStopFailure, string> = {
  not_configured:
    "This business has no browser service running, so there is nothing to demonstrate on.",
  not_updated:
    "This business's browser service has not been updated yet, so a demonstration cannot run safely. Ask us to update it.",
  render_failed: "The browser service could not be reached."
};

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    const result = await stopBrowseDemo(body.businessId, body.demoId);
    if (!result.ok) {
      const message = FAILURE_MESSAGES[result.error];
      return errorResponse(
        "VALIDATION_ERROR",
        result.detail ? `${message} (${result.detail})` : message
      );
    }

    // Pairs with aiflow_demo_started so the audit trail brackets the session.
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "info",
      event: "aiflow_demo_stopped",
      message: `Browse-step demonstration stopped by ${user.email}`,
      payload: {
        demoId: body.demoId,
        ...(result.actionsCount !== undefined ? { actionsCount: result.actionsCount } : {})
      }
    });

    return successResponse({
      ok: true,
      ...(result.actionsCount !== undefined ? { actionsCount: result.actionsCount } : {})
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
