import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createCheckoutSession, resolveIntroDiscountCouponId, resolvePriceId } from "@/lib/stripe/client";
import { createSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { verifyOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import { getBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import {
  LIFETIME_SUBSCRIPTION_CAP,
  upsertCustomerProfile,
  getCustomerProfileById
} from "@/lib/db/customer-profiles";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getCommitmentMonths } from "@/lib/plans/tier";

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
        metadataUserId = body.businessId;
        customerEmail = body.ownerEmail;
      } else {
        return errorResponse("FORBIDDEN", "Authentication required");
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
      const profile = await getCustomerProfileById(customerProfileId);
      if (
        profile &&
        profile.lifetime_subscription_count >= LIFETIME_SUBSCRIPTION_CAP
      ) {
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
      cancelUrl: body.draftToken
        ? `${appUrl}/onboard/checkout?businessId=${encodeURIComponent(body.businessId)}&draftToken=${encodeURIComponent(body.draftToken)}`
        : `${appUrl}/onboard`,
      customerEmail,
      discountCouponId,
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
