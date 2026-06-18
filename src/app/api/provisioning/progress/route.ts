import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { timingSafeEqualUtf8 } from "@/lib/timing-safe-utf8";
import { tokenBindingAllowsBusiness } from "@/lib/rowboat/gateway-token";
import { recordProvisioningProgress } from "@/lib/provisioning/progress";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  percent: z.number(),
  phase: z.string().min(1).max(200),
  message: z.string().max(4000).optional().default("")
});

function verifyProgressToken(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected =
    process.env.PROVISIONING_PROGRESS_TOKEN ?? process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (expected === "") return false;
  return timingSafeEqualUtf8(token, expected);
}

export async function POST(request: Request) {
  if (!verifyProgressToken(request)) {
    return errorResponse("UNAUTHORIZED", "Invalid provisioning token", 401);
  }

  try {
    const json = await request.json();
    const parsed = bodySchema.parse(json);

    // Layer per-tenant binding on top of the progress-token check: if the
    // bearer is a known per-tenant token, it must belong to this businessId.
    // (Fail-open for the legacy/shared progress token.)
    if (!(await tokenBindingAllowsBusiness(request, parsed.businessId))) {
      return errorResponse("UNAUTHORIZED", "Token not valid for this business", 401);
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
