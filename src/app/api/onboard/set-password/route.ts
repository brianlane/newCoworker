import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { getPasswordValidationError } from "@/lib/password";
import { getStripe } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { z } from "zod";

const schema = z.object({
  sessionId: z.string().min(1),
  password: z.string().min(1)
});

/**
 * Mint or update the auth user for a paid Stripe Checkout session.
 *
 * This is the "Step 4 after payment" half of the Stripe-first onboarding
 * flow:
 *
 *   /onboard/checkout (anon) → /api/checkout (anon, onboardingToken-gated)
 *   → Stripe Checkout → /onboard/success?session_id=...
 *   → /api/onboard/finalize-signup (verifies paid session, lifts pending
 *     owner_email)
 *   → /api/onboard/set-password (THIS endpoint)
 *
 * Critically, we DO NOT use `supabase.auth.signUp()` here, because that
 * unconditionally triggers an email-confirmation roundtrip. The user
 * clicking the confirmation link sends a request to `/api/auth/callback`
 * carrying every accumulated `sb-*-auth-token.N` chunk in their cookie
 * jar — which on Vercel routinely overflows the ~32KB edge header limit
 * and surfaces as a 494 REQUEST_HEADER_TOO_LARGE the user has no path
 * to recover from. Instead we use the service-role admin API to mint
 * the user with `email_confirm: true` so they can immediately
 * `signInWithPassword` on the client without any email hop. The Stripe
 * session id is the credential here: it is signed by Stripe and we
 * re-fetch the live session (rather than trusting any client payload)
 * before touching auth.
 *
 * Idempotent on retry: if the auth user already exists for the paid
 * email (user refreshed mid-flow, browser navigated back, network
 * dropped after admin.createUser but before signInWithPassword), we
 * fall through to `admin.updateUserById` to set the new password.
 * Returning an error in that case would strand a paid customer on a
 * page they can't make progress from.
 */
export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());

    // Mirror the client-side rule check so a degraded client
    // (e.g. JS disabled, manual fetch, replay) can't slip a weak
    // password past Supabase's defaults — and so the server-side
    // contract for password strength is explicit and testable.
    const passwordError = getPasswordValidationError(body.password);
    if (passwordError) {
      return errorResponse("VALIDATION_ERROR", passwordError, 400);
    }

    // Re-fetch the Stripe session server-side. Never trust a client-
    // supplied email or businessId here: the only tamper-proof source
    // of "this email paid for this business" is the Stripe session
    // itself, which is signed by Stripe and only retrievable with the
    // service-role secret. A request that lands here with a session id
    // someone else owns will fail the email lookup against
    // `customer_details.email` because Stripe binds the email at
    // checkout time.
    const stripe = getStripe();
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(body.sessionId);
    } catch (err) {
      logger.warn("set-password: stripe checkout session retrieve failed", {
        sessionId: body.sessionId,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse("FORBIDDEN", "Could not verify your payment. Please retry.", 403);
    }

    if (session.status !== "complete") {
      return errorResponse("FORBIDDEN", "Checkout session is not complete", 403);
    }
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return errorResponse("FORBIDDEN", "Payment has not succeeded", 403);
    }

    const businessId = session.metadata?.businessId ?? null;
    const ownerEmail = session.customer_details?.email ?? session.customer_email ?? null;

    if (!businessId || !ownerEmail) {
      return errorResponse(
        "FORBIDDEN",
        "Checkout session is missing verified customer details",
        403
      );
    }

    const db = await createSupabaseServiceClient();

    // Look up an existing auth user for this email BEFORE attempting to
    // create one. This makes the route safely idempotent on retry without
    // having to interpret Supabase's "user already registered" error
    // strings (which are not part of a stable public contract).
    let authUserId = await findAuthUserIdByEmail(ownerEmail);

    if (!authUserId) {
      const { data: created, error: createErr } = await db.auth.admin.createUser({
        email: ownerEmail,
        password: body.password,
        // CRITICAL: `email_confirm: true` is the entire point of routing
        // post-payment account creation through admin.createUser instead
        // of supabase.auth.signUp. It marks the email as confirmed
        // server-side and skips Supabase's "send confirmation email"
        // step, which is what previously triggered the 494 chain.
        email_confirm: true,
        user_metadata: {
          business_id: businessId
        }
      });

      if (createErr || !created?.user) {
        // Race: a parallel webhook or duplicate browser tab beat us to
        // it. Re-resolve and fall through to the update path. Any other
        // failure is a real error.
        const racedUserId = await findAuthUserIdByEmail(ownerEmail);
        if (!racedUserId) {
          logger.error("set-password: admin.createUser failed", {
            sessionId: body.sessionId,
            businessId,
            error: createErr?.message ?? "unknown"
          });
          return errorResponse(
            "INTERNAL_SERVER_ERROR",
            "Could not create your account. Please retry or contact support.",
            500
          );
        }
        authUserId = racedUserId;
      } else {
        authUserId = created.user.id;
      }
    }

    if (!authUserId) {
      // Defensive: should be impossible after the branch above, but a
      // null id flowing into admin.updateUserById would 500 with a less
      // helpful message.
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Could not resolve your account. Please retry or contact support.",
        500
      );
    }

    // Always set the password (and re-confirm the email) on the resolved
    // user id. Two cases hit this:
    //   1. We just created the user above (no-op-ish: we already set the
    //      password at create time, but re-applying is safe and aligns
    //      retry behavior).
    //   2. The user already existed — could be the same person retrying,
    //      could also be a returning customer paying for a new business
    //      under their existing email. In either case the customer
    //      JUST proved control of this email by completing a Stripe
    //      Checkout that delivered a receipt to it, so accepting the
    //      new password is correct.
    const { error: updateErr } = await db.auth.admin.updateUserById(authUserId, {
      password: body.password,
      email_confirm: true
    });

    if (updateErr) {
      logger.error("set-password: admin.updateUserById failed", {
        sessionId: body.sessionId,
        businessId,
        userId: authUserId,
        error: updateErr.message
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Could not save your password. Please retry.",
        500
      );
    }

    logger.info("set-password: auth user provisioned post-payment", {
      sessionId: body.sessionId,
      businessId,
      userId: authUserId
    });

    return successResponse({ ownerEmail, businessId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
