import { getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createCheckoutSession, resolveIntroDiscountCouponId, resolvePriceId } from "@/lib/stripe/client";
import { createSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getCommitmentMonths } from "@/lib/plans/tier";

const schema = z.object({
  tier: z.enum(["starter", "standard"]),
  businessId: z.string().uuid(),
  billingPeriod: z.enum(["monthly", "annual", "biennial"]).default("biennial"),
  ownerEmail: z.string().email().optional(),
  signupUserId: z.string().uuid().optional()
});

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
      if (!body.ownerEmail) {
        return errorResponse("FORBIDDEN", "Authentication required");
      }
      if (body.signupUserId) {
        const isValidSignupIdentity = await verifySignupIdentity(body.signupUserId, body.ownerEmail);
        if (!isValidSignupIdentity) {
          return errorResponse("FORBIDDEN", "Not authorized for checkout");
        }
        metadataUserId = body.signupUserId;
      } else {
        metadataUserId = body.ownerEmail;
      }
      customerEmail = body.ownerEmail;
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
      commitment_months: commitmentMonths
    });

    const session = await createCheckoutSession({
      priceId,
      successUrl: `${appUrl}/onboard/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/onboard`,
      customerEmail,
      discountCouponId,
      metadata: {
        businessId: body.businessId,
        tier: body.tier,
        billingPeriod: body.billingPeriod,
        userId: metadataUserId
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
