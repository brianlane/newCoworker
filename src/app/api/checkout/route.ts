import { authUserExistsByEmail, getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createCheckoutSession, resolveIntroDiscountCouponId, resolvePriceId } from "@/lib/stripe/client";
import { createSubscription, findCheckoutBlockingSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import { getBusiness, listBusinessIdsByOwnerEmail, setBusinessCustomerProfile } from "@/lib/db/businesses";
import {
  LIFETIME_SUBSCRIPTION_CAP,
  upsertCustomerProfile,
  getCustomerProfileById
} from "@/lib/db/customer-profiles";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getCommitmentMonths } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";

const schema = z.object({
  tier: z.enum(["starter", "standard"]),
  businessId: z.string().uuid(),
  billingPeriod: z.enum(["monthly", "annual", "biennial"]).default("biennial"),
  ownerEmail: z.string().email().optional(),
  onboardingToken: z.string().min(1).optional(),
  signupUserId: z.string().uuid().optional(),
  draftToken: z.string().uuid().optional()
});

/**
 * Best-effort signup IP: prefers the left-most (client) value of
 * `x-forwarded-for`, falls back to `x-real-ip`, otherwise `null`. The IP is
 * stored on the customer profile for abuse correlation only — a missing or
 * spoofed header never blocks checkout, it just weakens later identity
 * merging.
 */
function readClientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return null;
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    const body = schema.parse(await request.json());
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    let customerEmail: string | undefined;
    let metadataUserId: string;

    if (user) {
      customerEmail = user.email ?? undefined;
      metadataUserId = user.userId;
    } else {
      if (body.ownerEmail && body.signupUserId) {
        const isValidSignupIdentity = await verifySignupIdentity(body.signupUserId, body.ownerEmail);
        if (!isValidSignupIdentity) {
          return errorResponse("FORBIDDEN", "Not authorized for checkout");
        }
        metadataUserId = body.signupUserId;
        customerEmail = body.ownerEmail;
      } else if (body.ownerEmail && body.onboardingToken && verifyOnboardingToken(body.onboardingToken, { businessId: body.businessId })) {
        const business = await getBusiness(body.businessId);
        if (!business || business.owner_email !== createPendingOwnerEmail(body.businessId)) {
          return errorResponse("FORBIDDEN", "Onboarding token is no longer valid");
        }

        // Pre-payment account-uniqueness gate. By design, "account
        // creation" (post-payment `admin.createUser` in
        // /api/onboard/set-password) and "password reset" (the
        // standard Supabase `resetPasswordForEmail` link delivered to
        // the user's real mailbox) are SEPARATE flows. The anonymous
        // Stripe-first checkout has no business creating a paid
        // session bound to an email that ALREADY has an auth user —
        // doing so would either (a) collide with the post-payment
        // create and 409, stranding the customer on a paid checkout,
        // or (b) re-open the registration-injection surface if we
        // ever loosened set-password. The legitimate path for an
        // existing user is /login, not anonymous re-onboarding.
        //
        // Uses the strict `authUserExistsByEmail` helper so a
        // transient lookup failure surfaces as 500 (driving a client
        // retry) rather than silently allowing the checkout through.
        if (await authUserExistsByEmail(body.ownerEmail)) {
          logger.info("checkout blocked: email already has an auth user", {
            businessId: body.businessId
          });
          return errorResponse(
            "CONFLICT",
            "An account with this email already exists. Please sign in to continue.",
            409
          );
        }

        metadataUserId = body.businessId;
        customerEmail = body.ownerEmail;
      } else {
        return errorResponse("FORBIDDEN", "Authentication required");
      }
    }

    // Re-onboarding hard stop: this route exists ONLY to start a brand-new
    // subscription from the onboarding flow. If the posted business — or any
    // business the signed-in user owns — already has live/paid service
    // (active, canceled-in-grace, or a paid row mid-webhook), refuse before
    // inserting the `pending` row. A stale onboarding draft once shadowed a
    // live tenant's active subscription this way (the "Amy reset" incident);
    // plan changes and reactivation belong to the Billing page routes, which
    // operate on the existing subscription instead of minting a new one.
    // `findCheckoutBlockingSubscription` throws on a read error (fail closed).
    {
      const guardBusinessIds = new Set<string>([body.businessId]);
      if (user?.email) {
        for (const id of await listBusinessIdsByOwnerEmail(user.email)) {
          guardBusinessIds.add(id);
        }
      }
      const blocking = await findCheckoutBlockingSubscription([...guardBusinessIds]);
      if (blocking) {
        logger.info("checkout blocked: business/owner already has a live subscription", {
          businessId: body.businessId,
          blockingSubscriptionId: blocking.id,
          blockingBusinessId: blocking.business_id,
          blockingStatus: blocking.status
        });
        return errorResponse(
          "CONFLICT",
          "This account already has an active subscription. Manage your plan from the Billing page instead of starting a new signup.",
          409
        );
      }
    }

    // Abuse profile: upsert the `customer_profiles` row for this email + IP
    // and block checkout if the profile has already consumed its lifetime
    // subscription allotment (cap = 3). The count is only incremented on
    // `checkout.session.completed` — not here — so abandoned checkouts
    // don't burn lifetimes. If the profile cannot be upserted we block
    // checkout; otherwise failures here could bypass the lifetime cap.
    //
    // If we can't resolve an email at all we FAIL CLOSED: without an email
    // the abuse tracker can't enforce the lifetime cap, so allowing the
    // checkout to proceed would silently open a bypass for any auth
    // identity without an email on the session (OAuth provider that
    // doesn't expose email, etc.).
    const profileEmail = customerEmail;
    const signupIp = readClientIpFromHeaders(request.headers);
    let customerProfileId: string | null = null;
    if (!profileEmail) {
      logger.warn("checkout blocked: no email available for abuse tracking", {
        businessId: body.businessId,
        authenticatedUserId: user?.userId ?? null
      });
      return errorResponse(
        "FORBIDDEN",
        "A verified email is required to start a subscription. Contact support if you think this is a mistake.",
        403
      );
    }
    try {
      customerProfileId = await upsertCustomerProfile({
        email: profileEmail,
        signupIp
      });
    } catch (err) {
      logger.warn("customer_profiles upsert failed during checkout", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Could not verify subscription eligibility. Please retry.",
        500
      );
    }

    if (customerProfileId) {
      // Fail closed: we JUST upserted this profile id above, so a null
      // readback indicates a transient DB fault (replica lag, read
      // timeout, etc.) — proceeding would silently bypass the lifetime
      // subscription cap enforcement. Surface a 500 so the client
      // retries instead.
      let profile;
      try {
        profile = await getCustomerProfileById(customerProfileId);
      } catch (err) {
        logger.warn("customer_profiles readback failed during checkout", {
          businessId: body.businessId,
          profileId: customerProfileId,
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse(
          "INTERNAL_SERVER_ERROR",
          "Could not verify subscription eligibility. Please retry.",
          500
        );
      }
      if (!profile) {
        logger.warn("customer_profiles readback returned null post-upsert; blocking to avoid cap bypass", {
          businessId: body.businessId,
          profileId: customerProfileId
        });
        return errorResponse(
          "INTERNAL_SERVER_ERROR",
          "Could not verify subscription eligibility. Please retry.",
          500
        );
      }
      if (profile.lifetime_subscription_count >= LIFETIME_SUBSCRIPTION_CAP) {
        logger.info("checkout blocked: lifetime subscription cap reached", {
          businessId: body.businessId,
          profileId: customerProfileId,
          count: profile.lifetime_subscription_count
        });
        return errorResponse(
          "FORBIDDEN",
          "You've reached the maximum number of subscription signups for this account. Contact support if you need another.",
          403
        );
      }
    }

    const priceId = resolvePriceId(body.tier, body.billingPeriod);
    const discountCouponId = resolveIntroDiscountCouponId(body.tier, body.billingPeriod);
    const commitmentMonths = getCommitmentMonths(body.billingPeriod);
    const now = new Date();
    const originalDay = now.getDate();
    const renewalAt = new Date(now);
    renewalAt.setDate(1);
    renewalAt.setMonth(renewalAt.getMonth() + commitmentMonths);
    const daysInTargetMonth = new Date(renewalAt.getFullYear(), renewalAt.getMonth() + 1, 0).getDate();
    renewalAt.setDate(Math.min(originalDay, daysInTargetMonth));

    await createSubscription({
      id: randomUUID(),
      business_id: body.businessId,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: body.tier,
      status: "pending",
      billing_period: body.billingPeriod,
      renewal_at: renewalAt.toISOString(),
      commitment_months: commitmentMonths,
      customer_profile_id: customerProfileId
    });

    if (customerProfileId) {
      try {
        await setBusinessCustomerProfile(body.businessId, customerProfileId);
      } catch (err) {
        logger.warn("businesses.customer_profile_id attach failed during checkout", {
          businessId: body.businessId,
          profileId: customerProfileId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const session = await createCheckoutSession({
      priceId,
      successUrl: `${appUrl}/onboard/success?session_id={CHECKOUT_SESSION_ID}`,
      // Stripe-cancel returns the user to the questionnaire, where the
      // localStorage draft already has `businessId` + `draftToken` +
      // `persistedToDatabase: true`, so retrying "Proceed to Payment"
      // skips /api/business/create and just re-mints the Stripe session.
      // We pass `tier`/`period` so the QuestionnairePage Suspense'd
      // useSearchParams resolves the right plan on Step 3. We don't echo
      // `businessId`/`draftToken` in the URL because the questionnaire
      // reads them from localStorage and exposing them in the URL would
      // hand a checkout-resumption surface to anyone with link-leak
      // logging (referrer headers, browser history, screenshares).
      cancelUrl: `${appUrl}/onboard/questionnaire?tier=${encodeURIComponent(body.tier)}&period=${encodeURIComponent(body.billingPeriod)}`,
      customerEmail,
      discountCouponId,
      // New signups register a fresh 10DLC campaign — pass the carrier fee
      // through as a one-time line item. Plan changes and reactivations
      // (separate routes) keep the existing campaign and never re-charge it.
      oneTimeCarrierFeeCents: CARRIER_REGISTRATION_FEE_CENTS,
      metadata: {
        businessId: body.businessId,
        tier: body.tier,
        billingPeriod: body.billingPeriod,
        userId: metadataUserId,
        ...(customerProfileId ? { customerProfileId } : {})
      }
    });

    return successResponse({ checkoutUrl: session.url });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
