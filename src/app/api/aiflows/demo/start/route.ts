/**
 * Start a browse-step demonstration: open a LIVE page on the tenant's render
 * sidecar (logged in via the named integration when given) and return the
 * demoId plus the first turn's page state.
 *
 * POST { businessId, url, integrationLabel? }
 *   -> { demoId, loggedIn, finalUrl, digest, pageText, screenshotBase64? }
 *
 * Unlike the page picker and the dry run, a demonstration ACTS on the real
 * page (that is its whole point: it can walk past the as-loaded limitation),
 * so every act is executed by the sidecar under its own confirm gate. Gated
 * to Standard+, the same tier as the step it teaches.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { startBrowseDemo, type DemoStartFailure } from "@/lib/ai-flows/demo-session";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";
import { recordSystemLog } from "@/lib/db/system-logs";

/**
 * The platform budget must EXCEED the lib's own 120s abort, or the request is
 * cut before `startBrowseDemo` can answer and the owner is told the browser
 * service could not be reached while a live, logged-in sidecar session sits
 * there with a demoId nobody received, unstoppable until the idle sweep
 * reclaims it. Opening a page behind a fresh portal login is the slowest
 * thing this feature does (page load, login form, resolve, re-navigate,
 * settle), so it gets the headroom rather than the default.
 */
export const maxDuration = 150;

const bodySchema = z.object({
  businessId: z.string().uuid(),
  url: z.string().min(1).max(2000),
  integrationLabel: z.string().min(1).max(80).optional()
});

/**
 * Keyed on the exported union, so a new failure mode in the lib is a compile
 * error here rather than the word "undefined" reaching an owner.
 */
const FAILURE_MESSAGES: Record<DemoStartFailure, string> = {
  not_configured:
    "This business has no browser service running, so there is nothing to demonstrate on.",
  unsafe_url: "That address is not a public web page.",
  not_updated:
    "This business's browser service has not been updated yet, so a demonstration cannot run safely. Ask us to update it.",
  login_failed:
    "The page needs a login and the saved credentials were not accepted. Check that integration's username and password.",
  demo_limit:
    "Another demonstration is already running for this business. Finish or cancel it first, or wait a few minutes for it to expire.",
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

    const result = await startBrowseDemo(body.businessId, body.url, {
      ...(body.integrationLabel ? { integrationLabel: body.integrationLabel } : {})
    });
    if (!result.ok) {
      const message = FAILURE_MESSAGES[result.error];
      return errorResponse(
        "VALIDATION_ERROR",
        result.detail ? `${message} (${result.detail})` : message
      );
    }

    // Audit trail ("the owner finds out anyway" applies to us too): a live
    // session was opened on a vendor portal with the tenant's login. The
    // resulting step edit is snapshotted by the versions trigger on save;
    // this records that the session itself happened. Best-effort.
    await recordSystemLog({
      businessId: body.businessId,
      source: "aiflow",
      level: "info",
      event: "aiflow_demo_started",
      message: `Browse-step demonstration started by ${user.email}`,
      payload: {
        demoId: result.demoId,
        url: body.url,
        ...(body.integrationLabel ? { integrationLabel: body.integrationLabel } : {}),
        loggedIn: result.loggedIn
      }
    });

    return successResponse({
      demoId: result.demoId,
      loggedIn: result.loggedIn,
      finalUrl: result.finalUrl,
      digest: result.digest,
      pageText: result.pageText,
      ...(result.screenshotBase64 ? { screenshotBase64: result.screenshotBase64 } : {}),
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {})
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
