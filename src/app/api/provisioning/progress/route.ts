import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
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
  if (expected === "" || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function POST(request: Request) {
  if (!verifyProgressToken(request)) {
    return errorResponse("UNAUTHORIZED", "Invalid provisioning token", 401);
  }

  try {
    const json = await request.json();
    const parsed = bodySchema.parse(json);
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
