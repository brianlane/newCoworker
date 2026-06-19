import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { timingSafeEqualUtf8 } from "@/lib/timing-safe-utf8";
import { extractBearerToken, verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { recordProvisioningProgress } from "@/lib/provisioning/progress";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  percent: z.number(),
  phase: z.string().min(1).max(200),
  message: z.string().max(4000).optional().default("")
});

/**
 * An explicit, operator-set provisioning token (distinct from any gateway token).
 * When unset, orchestration deploys the per-tenant gateway token as the progress
 * bearer instead — that path is handled by `verifyGatewayTokenForBusiness` below.
 */
function matchesExplicitProgressToken(request: Request): boolean {
  const expected = process.env.PROVISIONING_PROGRESS_TOKEN ?? "";
  if (expected === "") return false;
  return timingSafeEqualUtf8(extractBearerToken(request), expected);
}

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = bodySchema.parse(json);

    // Auth: accept the explicit PROVISIONING_PROGRESS_TOKEN, otherwise require a
    // gateway token bound to this businessId (per-tenant token, or the shared
    // ROWBOAT_GATEWAY_TOKEN fallback for boxes not yet on a per-tenant token).
    const authorized =
      matchesExplicitProgressToken(request) ||
      (await verifyGatewayTokenForBusiness(request, parsed.businessId));
    if (!authorized) {
      return errorResponse("UNAUTHORIZED", "Invalid provisioning token", 401);
    }

    const percent = Math.max(0, Math.min(100, Math.round(parsed.percent)));
    const status =
      percent >= 100 ? ("success" as const) : ("thinking" as const);

    await recordProvisioningProgress({
      businessId: parsed.businessId,
      phase: parsed.phase,
      percent,
      message: parsed.message || `VPS: ${parsed.phase}`,
      source: "vps",
      status
    });

    return successResponse({ received: true });
  } catch (e) {
    return handleRouteError(e);
  }
}
