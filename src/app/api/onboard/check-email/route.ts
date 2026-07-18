import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { z } from "zod";

const schema = z.object({
  email: z.string().email()
});

// Durable (cross-isolate) limit: this endpoint leaks "has account / does not
// have account" per email, so the per-IP quota must bind fleet-wide — the
// in-memory proxy limiter is per-isolate and lets a distributed caller
// enumerate far past the configured numbers (audit 2026-07, finding M3).
const CHECK_EMAIL_RATE = { interval: 60 * 1000, maxRequests: 10 };

/**
 * UX preflight for the questionnaire's email field.
 *
 * Lets the client tell the user "this email already has an account,
 * please sign in" the moment they advance past step 1, instead of
 * forcing them to fill out the entire questionnaire and click
 * "Proceed to Payment" before getting that signal.
 *
 * Intentionally NOT the security boundary. The actual gate that
 * prevents an anonymous Stripe-first checkout from binding to an
 * existing user's email lives on `/api/checkout` (and uses the
 * strict `authUserExistsByEmail` helper that throws on lookup
 * failure). This endpoint uses the SOFT `findAuthUserIdByEmail`
 * helper and reports `available: true` whenever it cannot prove
 * the email is taken — fail-open is the right call here because
 * a transient lookup failure should not strand a legitimate
 * signup mid-questionnaire when the server-side gate downstream
 * will catch the rare bad case.
 *
 * Privacy note: this leaks "has account / does not have account"
 * for any email an anonymous caller can guess. That's the same
 * signal the public /login page leaks (any failed login at a
 * known-bad password reveals the same), so it doesn't expand the
 * existing privacy surface. Enumeration speed is bounded by the
 * durable per-IP limiter below (fleet-wide, not per-isolate).
 */
export async function POST(request: Request) {
  try {
    const limiter = await rateLimitDurable(
      `onboard-check-email:${rateLimitIdentifierFromRequest(request)}`,
      CHECK_EMAIL_RATE
    );
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests. Please wait a minute and try again.", 429);
    }

    const body = schema.parse(await request.json());

    let existingUserId: string | null = null;
    try {
      existingUserId = await findAuthUserIdByEmail(body.email);
    } catch (err) {
      logger.warn("check-email: soft lookup threw; treating as available", {
        error: err instanceof Error ? err.message : String(err)
      });
      // Fall through to `available: true` — the security gate at
      // /api/checkout uses the strict variant and will catch any
      // false negative we leak from this preflight.
    }

    return successResponse({ available: existingUserId === null });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid request");
    }
    return handleRouteError(err);
  }
}
