import { getAuthUser } from "@/lib/auth";
import { createCustomerPortalSession } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import { errorResponse, handleRouteError } from "@/lib/api-response";

export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("FORBIDDEN", "Authentication required", 403);
    }

    const db = await createSupabaseServiceClient();
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
      .limit(1);

    const business = businesses?.[0] ?? null;
    if (!business) {
      return errorResponse("NOT_FOUND", "Business not found", 404);
    }

    const subscription = await getSubscription(business.id);
    if (!subscription?.stripe_customer_id) {
      return errorResponse("NOT_FOUND", "Stripe customer not found", 404);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const session = await createCustomerPortalSession({
      customerId: subscription.stripe_customer_id,
      returnUrl: `${appUrl}/dashboard/settings`
    });

    return Response.redirect(session.url, 303);
  } catch (err) {
    return handleRouteError(err);
  }
}
