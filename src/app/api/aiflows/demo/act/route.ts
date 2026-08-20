/**
 * One demonstrated interaction: the sidecar EXECUTES it on the live page and
 * answers with what it recorded plus the page afterwards.
 *
 * POST { businessId, demoId, action, confirm? }
 *   -> { outcome: "recorded", recorded, actionsCount, finalUrl, digest, ... }
 *   -> { outcome: "needs_confirm" | "resolve_failed" | "action_failed"
 *              | "demo_gone" | "action_cap", ... }
 *
 * Every outcome above is a SUCCESS response: they are turns of the
 * demonstration the panel continues from, not errors. errorResponse is
 * reserved for auth, validation, the plan gate, and transport-level failures
 * (no sidecar, stale sidecar, unreachable sidecar).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { actBrowseDemo, type DemoActFailure } from "@/lib/ai-flows/demo-session";
import {
  BROWSE_ACTION_UPGRADE_MESSAGE,
  browseActionAllowedForBusiness
} from "@/lib/plans/browse-action";

/** The engine kinds a demo may send directly (no click_text_while_present:
 * a demo turn is one interaction, never a bounded loop). */
const STANDARD_KINDS = [
  "click_text",
  "click_selector",
  "fill_selector",
  "fill_placeholder",
  "click_role",
  "select_option"
] as const;

/** Kinds whose value is required, mirroring the schema and the sidecar. */
const VALUE_REQUIRED_KINDS = new Set(["click_role", "select_option"]);

const standardActionSchema = z
  .object({
    kind: z.enum(STANDARD_KINDS),
    target: z.string().min(1).max(300),
    value: z.string().max(2000).optional()
  })
  .refine((a) => !VALUE_REQUIRED_KINDS.has(a.kind) || (a.value ?? "").length > 0, {
    message: "This action kind needs a value (the option to choose, or the control's name)."
  });

const pointActionSchema = z.object({
  kind: z.enum(["click_point", "fill_point"]),
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
  value: z.string().max(2000).optional()
});

const bodySchema = z.object({
  businessId: z.string().uuid(),
  demoId: z.string().uuid(),
  confirm: z.boolean().optional(),
  action: z.union([standardActionSchema, pointActionSchema])
});

/**
 * Keyed on the exported union, so a new failure mode in the lib is a compile
 * error here rather than the word "undefined" reaching an owner.
 */
const FAILURE_MESSAGES: Record<DemoActFailure, string> = {
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

    if (!(await browseActionAllowedForBusiness(body.businessId))) {
      return errorResponse("VALIDATION_ERROR", BROWSE_ACTION_UPGRADE_MESSAGE);
    }

    const result = await actBrowseDemo(body.businessId, body.demoId, body.action, {
      ...(body.confirm ? { confirm: true } : {})
    });
    if (!result.ok) {
      const message = FAILURE_MESSAGES[result.error];
      return errorResponse(
        "VALIDATION_ERROR",
        result.detail ? `${message} (${result.detail})` : message
      );
    }
    // The whole outcome union rides through as data; the panel branches on
    // `outcome`, not on message strings.
    const { ok: _ok, ...outcome } = result;
    return successResponse(outcome);
  } catch (err) {
    return handleRouteError(err);
  }
}
