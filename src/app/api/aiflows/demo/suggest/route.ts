/**
 * AI refinements over a finished demonstration: which typed literals should
 * become {{...}} placeholders, and a proposed "Proof it worked" marker read
 * off the final page.
 *
 * POST { businessId, actions, varsInScope, afterPageText }
 *   -> { suggestions: { fills: [{ index, placeholder }], expectText? } }
 *
 * varsInScope comes from the CLIENT (the builder's variables palette computes
 * scope for possibly-unsaved flows), which is safe because a suggestion is
 * only ever an offered chip the owner accepts by hand, the lib clamps every
 * placeholder against exactly this list, and the flow save re-validates
 * template scope regardless (parseAiFlowDefinition).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  DEMO_SUGGEST_MAX_VARS,
  suggestDemoRefinements,
  type DemoSuggestFailure
} from "@/lib/ai-flows/demo-suggest";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  actions: z
    .array(
      z.object({
        kind: z.string().min(1).max(40),
        target: z.string().min(1).max(300),
        value: z.string().max(2000).optional()
      })
    )
    .min(1)
    .max(15),
  varsInScope: z.array(z.string().min(1).max(120)).max(DEMO_SUGGEST_MAX_VARS),
  afterPageText: z.string().max(20_000)
});

/**
 * Keyed on the exported union, so a new failure mode in the lib is a compile
 * error here rather than the word "undefined" reaching an owner.
 */
const FAILURE_MESSAGES: Record<DemoSuggestFailure, string> = {
  not_configured: "AI assist is not configured.",
  generation_failed: "Suggestions could not be generated this time. The recording is unaffected."
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

    const result = await suggestDemoRefinements({
      businessId: body.businessId,
      actions: body.actions,
      varsInScope: body.varsInScope,
      afterPageText: body.afterPageText
    });
    if (!result.ok) {
      return errorResponse("VALIDATION_ERROR", FAILURE_MESSAGES[result.error]);
    }
    return successResponse({ suggestions: result.suggestions });
  } catch (err) {
    return handleRouteError(err);
  }
}
