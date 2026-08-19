/**
 * "Try these actions" for a browse step: report whether each action would
 * find something to act on, without performing any of them.
 *
 * POST { businessId, url, actions, integrationLabel? }
 *   -> { finalUrl, checks, screenshotBase64? }
 *
 * The dashboard's "Test with a contact" simulates browse steps entirely
 * (test_mode.ts echoes the action list and never opens a browser), so this is
 * the only way to find out whether a sequence still matches a vendor's markup
 * short of running it on a live lead.
 *
 * Gated to Standard+, the same tier as the step it serves.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  MAX_CHECKABLE_ACTIONS,
  checkBrowseActions,
  type CheckActionsFailure
} from "@/lib/ai-flows/action-check";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  url: z.string().min(1).max(2000),
  integrationLabel: z.string().min(1).max(80).optional(),
  actions: z
    .array(
      z.object({
        kind: z.string().min(1).max(40),
        target: z.string().min(1).max(300),
        value: z.string().max(2000).optional()
      })
    )
    .min(1)
    .max(MAX_CHECKABLE_ACTIONS)
});

/**
 * Keyed on the exported union, so a new failure mode in the lib is a compile
 * error here rather than the word "undefined" reaching an owner.
 */
const FAILURE_MESSAGES: Record<CheckActionsFailure, string> = {
  not_configured:
    "This business has no browser service running, so the actions cannot be tried from here.",
  unsafe_url: "That address is not a public web page.",
  no_actions: "Add at least one action with something to aim at before trying them.",
  login_failed:
    "The page needs a login and the saved credentials were not accepted. Check that integration's username and password.",
  render_failed: "The page could not be opened."
};

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    if (!(await browseActionAllowedForBusiness(body.businessId))) {
      return errorResponse("VALIDATION_ERROR", BROWSE_ACTION_UPGRADE_MESSAGE);
    }

    const result = await checkBrowseActions(body.businessId, body.url, body.actions, {
      ...(body.integrationLabel ? { integrationLabel: body.integrationLabel } : {})
    });
    if (!result.ok) {
      const message = FAILURE_MESSAGES[result.error];
      return errorResponse(
        "VALIDATION_ERROR",
        result.detail ? `${message} (${result.detail})` : message
      );
    }
    return successResponse({
      finalUrl: result.finalUrl,
      checks: result.checks,
      ...(result.screenshotBase64 ? { screenshotBase64: result.screenshotBase64 } : {})
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
