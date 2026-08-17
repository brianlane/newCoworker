import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { recordAcceptance } from "@/lib/legal/acceptance";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";

const schema = z.object({
  email: z.string().email().max(320).optional()
});

// The unauthenticated path exists for exactly one caller: the /signup form's
// pre-session evidence row (email confirmation still pending, so there is no
// session to record against). Per-IP durable limit keeps it from becoming a
// junk-row firehose; the ledger is insert-only evidence, not state.
const UNAUTH_RATE = { interval: 15 * 60 * 1000, maxRequests: 20 };

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json().catch(() => ({})));
    const ip = rateLimitIdentifierFromRequest(request);
    const userAgent = request.headers.get("user-agent");

    const user = await getAuthUser();
    if (user) {
      // USER-scoped: the row belongs to whoever's consent it records. An
      // admin in view-as records it for the impersonated OWNER (their own
      // acceptance state is irrelevant to the tenant's gate), stamped with
      // the 'admin_view_as' source so the ledger never presents an operator
      // click as the tenant's own. A tenant with no login behind its
      // owner_email has no gate to clear, so there is nothing to record.
      const target = await resolveViewAsTargetUser(user);
      if (!target.userId) {
        return errorResponse(
          "NOT_FOUND",
          "This tenant's owner has no login yet, so there is no acceptance to record",
          404
        );
      }
      await recordAcceptance({
        userId: target.userId,
        email: target.email,
        source: target.impersonating ? "admin_view_as" : "gate",
        ip,
        userAgent
      });
      return successResponse({ recorded: true });
    }

    if (!body.email) {
      return errorResponse("UNAUTHORIZED", "Sign in, or provide the signup email", 401);
    }
    const limiter = await rateLimitDurable(`legal-accept:${ip}`, UNAUTH_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many attempts. Please wait and try again.", 429);
    }
    await recordAcceptance({ email: body.email, source: "signup", ip, userAgent });
    return successResponse({ recorded: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
