/**
 * Promo-code preview for the signup questionnaire's Step 3 order summary.
 *
 * Unauthenticated by necessity: the checkout that redeems the code is itself
 * anonymous (the flow is Stripe-first, the account is minted after payment).
 * The middleware's per-IP API bucket covers abuse, and there is little to
 * harvest here anyway, because a promo code is meant to be shared, and the response
 * says only whether one applies and how much it takes off.
 *
 * `/api/checkout` re-runs the same `validatePromotionCode` server-side, so a
 * client that skips or forges this preview cannot obtain a discount.
 */
import { z } from "zod";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { validatePromotionCode, type PromotionRejection } from "@/lib/promotions/validate";
import { PROMOTION_CODE_MAX_LENGTH, PROMOTION_CODE_MIN_LENGTH } from "@/lib/db/promotions";

const schema = z.object({
  code: z.string().trim().min(PROMOTION_CODE_MIN_LENGTH).max(PROMOTION_CODE_MAX_LENGTH),
  tier: z.enum(["starter", "standard"]),
  billingPeriod: z.enum(["monthly", "annual", "biennial"])
});

/**
 * Reasons collapse to two customer-facing messages. Telling someone a real
 * code exists but is capped, scheduled, or scoped to another plan invites
 * them to go hunting; "not valid for this plan" is the honest and useful
 * half of it, and "does not beat" explains the one case where refusing a
 * genuinely live code would otherwise look like a bug.
 */
function messageKeyFor(reason: PromotionRejection): "invalid" | "notBetter" {
  return reason === "not_better" ? "notBetter" : "invalid";
}

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const result = await validatePromotionCode({
      code: body.code,
      tier: body.tier,
      period: body.billingPeriod
    });

    if (!result.ok) {
      return successResponse({ valid: false, reason: messageKeyFor(result.reason) });
    }

    return successResponse({
      valid: true,
      code: result.promotion.code,
      name: result.promotion.name,
      discountCents: result.discountCents,
      planDueTodayCents: result.planDueTodayCents,
      // So the order summary can say the discount continues past the first
      // invoice: a repeating/forever code on a monthly plan can be the better
      // deal over its span while its month one is ABOVE the intro price, and
      // showing that without the continuation note would read as a mistake.
      duration: result.promotion.duration,
      durationInMonths: result.promotion.duration_in_months
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
