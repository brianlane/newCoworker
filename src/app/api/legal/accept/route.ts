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
      // The ONE view-as refusal left in the product, and it is a policy
      // decision rather than a wrong-row hazard: consent is not an action an
      // operator can take for someone else. Every other tenant-facing write
      // retargets to the impersonated owner, but a `terms_acceptances` row
      // exists to evidence that a SPECIFIC PERSON agreed, and nobody can
      // agree on their behalf. An operator-recorded row would be a
      // fabricated legal record no matter how it were labeled, so the
      // capability does not exist rather than existing-but-marked.
      //
      // The dashboard layout does not raise the clickwrap gate under view-as
      // either, so an operator is never shown a modal this refusal would
      // strand them behind.
      const target = await resolveViewAsTargetUser(user);
      if (target.impersonating) {
        return errorResponse(
          "FORBIDDEN",
          "Terms acceptance records a person's own consent, so it cannot be done for a tenant. Ask the owner to accept from their own login.",
          403
        );
      }
      await recordAcceptance({
        userId: user.userId,
        email: user.email,
        source: "gate",
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
