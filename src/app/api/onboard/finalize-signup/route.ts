import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getStripe } from "@/lib/stripe/client";
import { z } from "zod";

const schema = z.object({
  sessionId: z.string().min(1)
});

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(body.sessionId);

    if (session.status !== "complete") {
      return errorResponse("FORBIDDEN", "Checkout session is not complete", 403);
    }

    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return errorResponse("FORBIDDEN", "Payment has not succeeded", 403);
    }

    return successResponse({
      businessId: session.metadata?.businessId ?? null
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0].message);
    }
    return handleRouteError(err);
  }
}
