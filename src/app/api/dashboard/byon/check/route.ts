/**
 * BYON wizard step 1: instant portability check.
 *
 * POST /api/dashboard/byon/check
 *   body: { businessId: uuid, phone: string }
 *   → { check: PortabilityCheckSummary } ("ports in 1-4 business days" etc.)
 *
 * Auth mirrors /api/dashboard/csv: getAuthUser + requireOwner (admins bypass).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { ByonValidationError, runPortabilityCheck } from "@/lib/byon/port-requests";
import { assertByonAllowedForBusiness } from "@/lib/byon/tier-gate";

export const dynamic = "force-dynamic";

const CHECK_RATE = { interval: 60 * 1000, maxRequests: 10 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  phone: z.string().min(1, "Enter a phone number")
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const parsed = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireOwner(parsed.businessId);

    const limiter = rateLimit(`byon-check:${parsed.businessId}`, CHECK_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many checks, slow down.", 429);
    }

    // BYON is Standard-only: fail the wizard's first step with the upgrade
    // prompt instead of letting starters fill everything in and then bounce.
    await assertByonAllowedForBusiness(parsed.businessId);

    const check = await runPortabilityCheck(parsed.phone);
    return successResponse({ check });
  } catch (err) {
    if (err instanceof ByonValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    return handleRouteError(err);
  }
}
