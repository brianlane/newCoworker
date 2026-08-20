/**
 * "Open this page" for the browse-step editor: render a page on the tenant's
 * own sidecar and return the controls a `browse_action` could aim at, so a
 * selector is picked from the real page instead of typed from memory.
 *
 * POST { businessId, url, integrationLabel? } -> { finalUrl, digest }
 *
 * Read-only by construction: `probePageControls` never sends an `actions`
 * array, and this route has no field that could add one. The heaviest thing
 * it causes is the same portal login the tenant's flows already perform many
 * times a day.
 *
 * Gated to the same tier as the step it serves: browse_action is Standard+,
 * so a Starter tenant is told to upgrade rather than handed a browser.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { probePageControls, type ProbePageFailure } from "@/lib/ai-flows/page-probe";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";

/**
 * The platform budget must EXCEED `probePageControls`'s own 90s abort, or a
 * page picker pointed at a cold box plus a fresh portal login is cut short
 * and reads as "the page could not be opened". Found alongside the same
 * omission on the demonstration routes (Bugbot, PR #1554).
 */
export const maxDuration = 120;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  url: z.string().min(1).max(2000),
  /** `custom_integrations.label`, for a page behind the owner's account. */
  integrationLabel: z.string().min(1).max(80).optional()
});

/**
 * Owner-readable wording for each way a probe can fail. Keyed by the exported
 * union, so adding a failure mode in the lib fails this file to compile
 * rather than reaching an owner as "undefined".
 */
const FAILURE_MESSAGES: Record<ProbePageFailure, string> = {
  not_configured:
    "This business has no browser service running, so a page cannot be opened from here.",
  unsafe_url: "That address is not a public web page.",
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

    const result = await probePageControls(body.businessId, body.url, {
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
      digest: result.digest,
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {})
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
