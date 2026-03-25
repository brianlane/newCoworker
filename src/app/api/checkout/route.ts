import { requireAuth } from "@/lib/auth";
import { createCheckoutSession, resolvePriceId } from "@/lib/stripe/client";
import { createSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";
import { randomUUID } from "crypto";

const schema = z.object({
  tier: z.enum(["starter", "standard"]),
  businessId: z.string().uuid()
});

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = schema.parse(await request.json());
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const priceId = resolvePriceId(body.tier);

    const session = await createCheckoutSession({
      priceId,
      successUrl: `${appUrl}/onboard/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/onboard/payment`,
      customerEmail: user.email ?? undefined,
      metadata: { businessId: body.businessId, tier: body.tier, userId: user.userId }
    });

    await createSubscription({
      id: randomUUID(),
      business_id: body.businessId,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      tier: body.tier,
      status: "pending"
    });

    return successResponse({ checkoutUrl: session.url });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.errors[0].message);
    }
    return handleRouteError(err);
  }
}
