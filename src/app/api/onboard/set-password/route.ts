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
 * Mint the auth user for a paid Stripe Checkout session.
 *
 * This is the "Step 4 after payment" half of the Stripe-first onboarding
 * flow:
 *
 *   /onboard/checkout (anon) → /api/checkout (anon, onboardingToken-gated,
 *     refuses any email that already has a Supabase auth user — see the
 *     `authUserExistsByEmail` gate in that route)
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
 * `signInWithPassword` on the client without any email hop.
 *
 * CONTRACT — this route ONLY creates accounts. It never updates them.
 * -------------------------------------------------------------------
 * Account creation and password reset are deliberately separate flows:
 *
 *   - "Account creation" — this route. `admin.createUser` only.
 *     The pre-existence of any auth user for the email it's asked to
 *     mint is a hard 409 CONFLICT. The route never calls
 *     `admin.updateUserById`. Ever.
 *
 *   - "Password reset" — Supabase's `resetPasswordForEmail`, surfaced
 *     on /login. That flow requires control of the user's real mailbox
 *     (the reset link is delivered there) and is the ONLY path by
 *     which an existing account's password may be changed without
 *     proving the current password.
 *
 * Why the separation matters: Stripe's `customer_email` only PRE-FILLS
 * the Checkout form (the customer can edit it) and the client controls
 * `body.ownerEmail` on `/api/checkout`. "This Stripe session was paid
 * with email X" does NOT prove the caller controls the mailbox at X.
 * If this route ever updated an existing account's password based on
 * a paid session id, an attacker could pay any victim's email and take
 * over the victim's existing account (and, because app authz is
 * email-keyed, every business the victim already owns). Refusing the
 * update here — combined with the upstream uniqueness gate at
 * `/api/checkout` — closes that surface entirely.
 *
 * Reachability: in practice the upstream gate at `/api/checkout`
 * already refuses a checkout for any email that has an auth user, so
 * the 409 path below should never fire on a well-behaved client. It
 * exists as belt-and-suspenders defence-in-depth against:
 *   - a TOCTOU window in which the email becomes claimed between the
 *     `/api/checkout` gate and this route, and
 *   - same-session retry races (network drop after admin.createUser
 *     succeeded; client retries; second call sees the email taken).
 * In both cases the customer's correct recovery is /login with the
 * password they just typed (the legitimate first call set it).
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

    // Pure create-only path. This is the ENTIRE behaviour of this route
    // for the happy case: mint a brand-new auth user with the password
    // the customer just typed and `email_confirm: true` so they can
    // immediately `signInWithPassword` on the client without an email
    // confirmation hop. The route never updates an existing user — see
    // the docstring above for why "account creation" and "password
    // reset" are kept as separate flows.
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email: ownerEmail,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        business_id: businessId
      }
    });

    if (created?.user) {
      logger.info("set-password: auth user minted post-payment", {
        sessionId: body.sessionId,
        businessId,
        userId: created.user.id
      });
      return successResponse({ ownerEmail, businessId });
    }

    // createUser failed. Disambiguate the cause with a direct lookup:
    //
    //   - An existing user for `ownerEmail` means we hit a duplicate-
    //     email collision. In a well-behaved flow this is unreachable
    //     (the upstream `authUserExistsByEmail` gate on /api/checkout
    //     refuses checkouts for already-claimed emails), so reaching
    //     here implies either (a) a TOCTOU narrowed by the gate, or
    //     (b) a same-session retry race after a successful first
    //     create whose response was lost. Either way the right answer
    //     is 409 + "sign in to continue" — NEVER an admin-side
    //     password update.
    //
    //   - No existing user means the create truly failed (DB transient,
    //     bad request, etc.). 500 lets the client retry.
    const existingId = await findAuthUserIdByEmail(ownerEmail);
    if (!existingId) {
      logger.error("set-password: admin.createUser failed without a duplicate-email cause", {
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

    logger.warn("set-password: refusing to update an account that already exists for this email", {
      sessionId: body.sessionId,
      businessId,
      userId: existingId
    });
    return errorResponse(
      "CONFLICT",
      "An account with this email already exists. Please sign in to continue.",
      409
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
