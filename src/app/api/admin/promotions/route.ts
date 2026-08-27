/**
 * Admin CRUD for membership promotions (promo codes redeemable at signup).
 *
 * POST:   mint a promotion: Stripe Coupon + Promotion Code first, then the
 *          row that owns its lifecycle. A failed row insert deletes the Stripe
 *          objects again, so a rejected submit leaves nothing behind.
 * GET:    every promotion with its redemption stats and live lifecycle.
 * PATCH:  edit. Name, window, cap, and the toggle are plain row writes; a
 *          change to the discount VALUE or the tier scope has to mint a
 *          replacement Stripe coupon, because coupons are immutable.
 * DELETE: hard delete, allowed only while nobody has redeemed the code (the
 *          `on delete restrict` FK is the backstop). A redeemed promotion is
 *          switched off instead, so its attribution survives.
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import {
  countPromotionRedemptions,
  createPromotion,
  deletePromotion,
  getPromotion,
  getPromotionByCode,
  updatePromotion,
  PROMOTION_AMOUNT_MAX_CENTS,
  PROMOTION_AMOUNT_MIN_CENTS,
  PROMOTION_CODE_MAX_LENGTH,
  PROMOTION_CODE_MIN_LENGTH,
  PROMOTION_DURATION_MAX_MONTHS,
  type PromotionRow
} from "@/lib/db/promotions";
import { listBusinesses } from "@/lib/db/businesses";
import { listPromotionsWithStats } from "@/lib/promotions/stats";
import { normalizePromotionCode } from "@/lib/promotions/validate";
import {
  createPromotionCoupon,
  deletePromotionCoupon,
  replacePromotionCoupon,
  setPromotionCodeActive,
  type PromotionDiscount,
  type PromotionTier
} from "@/lib/stripe/promotions";
import { logger } from "@/lib/logger";

const tierEnum = z.enum(["starter", "standard"]);
const periodEnum = z.enum(["monthly", "annual", "biennial"]);
const durationEnum = z.enum(["once", "repeating", "forever"]);

/** Stripe's promotion-code charset, mirrored from the table CHECK. */
const codeSchema = z
  .string()
  .trim()
  .min(PROMOTION_CODE_MIN_LENGTH)
  .max(PROMOTION_CODE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9-]+$/, "Code may contain only letters, digits, and dashes");

const discountFields = {
  percentOff: z.number().gt(0).max(100).nullable().optional(),
  // Whole-dollar UI convenience, converted to cents server-side.
  amountOffUsd: z
    .number()
    .min(PROMOTION_AMOUNT_MIN_CENTS / 100)
    .max(PROMOTION_AMOUNT_MAX_CENTS / 100)
    .nullable()
    .optional(),
  duration: durationEnum.optional(),
  durationInMonths: z.number().int().min(1).max(PROMOTION_DURATION_MAX_MONTHS).nullable().optional()
};

const createSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(3).max(120),
  ...discountFields,
  allowedTiers: z.array(tierEnum).min(1),
  allowedPeriods: z.array(periodEnum).min(1),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  active: z.boolean().default(true)
});

const patchSchema = z.object({
  promotionId: z.string().uuid(),
  name: z.string().trim().min(3).max(120).optional(),
  ...discountFields,
  allowedTiers: z.array(tierEnum).min(1).optional(),
  allowedPeriods: z.array(periodEnum).min(1).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  active: z.boolean().optional()
});

type DiscountInput = {
  percentOff?: number | null;
  amountOffUsd?: number | null;
  duration?: "once" | "repeating" | "forever";
  durationInMonths?: number | null;
};

/**
 * Resolve the submitted discount to the shape both the table CHECK and Stripe
 * expect, or a message explaining what is wrong with it. Exactly one of
 * percent/amount, and a month count if and only if the duration repeats.
 */
function resolveDiscount(
  input: DiscountInput,
  fallback?: PromotionRow
): { ok: true; discount: PromotionDiscount } | { ok: false; message: string } {
  const percentOff =
    input.percentOff !== undefined ? input.percentOff : (fallback?.percent_off ?? null);
  const amountOffCents =
    input.amountOffUsd !== undefined
      ? input.amountOffUsd === null
        ? null
        : Math.round(input.amountOffUsd * 100)
      : (fallback?.amount_off_cents ?? null);

  if ((percentOff === null) === (amountOffCents === null)) {
    return { ok: false, message: "Set exactly one of a percentage off or an amount off" };
  }

  const duration = input.duration ?? fallback?.duration ?? "once";
  const durationInMonths =
    input.durationInMonths !== undefined
      ? input.durationInMonths
      : (fallback?.duration_in_months ?? null);

  if (duration === "repeating" && durationInMonths === null) {
    return { ok: false, message: "A repeating promotion needs a number of months" };
  }
  if (duration !== "repeating" && durationInMonths !== null) {
    return { ok: false, message: "Only a repeating promotion takes a number of months" };
  }

  return { ok: true, discount: { percentOff, amountOffCents, duration, durationInMonths } };
}

/**
 * A term (annual/biennial) plan is ONE prepaid invoice; its post-term
 * pricing belongs to the commitment schedule. A repeating/forever coupon on
 * a term plan therefore promises nothing the validation models, and whether
 * Stripe's schedule phase-2 rewrite drops a redeemed coupon is pinned
 * nowhere (schedule setup failure is explicitly non-fatal at checkout), so
 * such a code could silently discount every future full-term renewal
 * invoice. Refuse the combination at mint time.
 */
function termPeriodsForbidMultiCycle(
  duration: "once" | "repeating" | "forever",
  allowedPeriods: readonly string[]
): string | null {
  if (duration === "once") return null;
  const term = allowedPeriods.filter((p) => p === "annual" || p === "biennial");
  if (term.length === 0) return null;
  return (
    `A ${duration} discount cannot allow ${term.join("/")} plans: a term plan is one prepaid ` +
    "invoice, and a multi-cycle coupon riding into the commitment schedule would silently " +
    'discount full-term renewals. Use duration "once", or restrict the code to monthly.'
  );
}

/**
 * True when the edit changes something the Stripe objects fix at creation: the
 * coupon's discount, duration, and product scope, or the promotion code's
 * `max_redemptions`. None of those can be updated in place, so they can only
 * be changed by minting a replacement pair.
 */
function needsCouponReplacement(
  current: PromotionRow,
  discount: PromotionDiscount,
  tiers: PromotionTier[],
  maxRedemptions: number | null
): boolean {
  return (
    current.percent_off !== discount.percentOff ||
    current.amount_off_cents !== discount.amountOffCents ||
    current.duration !== discount.duration ||
    current.duration_in_months !== discount.durationInMonths ||
    current.max_redemptions !== maxRedemptions ||
    current.allowed_tiers.slice().sort().join(",") !== tiers.slice().sort().join(",")
  );
}

/**
 * What is left of a cap, for the promotion code Stripe will enforce.
 *
 * A replacement code counts from zero, so an edit hands Stripe the balance
 * rather than the whole allowance. Null means "do not cap at Stripe": either
 * the promotion is uncapped, or the allowance is already spent, in which case
 * our own `exhausted` check refuses the code before Stripe is ever asked
 * (Stripe rejects a `max_redemptions` below 1 anyway).
 */
function remainingRedemptions(
  maxRedemptions: number | null,
  alreadyRedeemed: number
): number | null {
  if (maxRedemptions === null) return null;
  const remaining = maxRedemptions - alreadyRedeemed;
  return remaining > 0 ? remaining : null;
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await request.json());

    const code = normalizePromotionCode(body.code);
    if (await getPromotionByCode(code)) {
      return errorResponse("CONFLICT", "A promotion with that code already exists");
    }

    const discount = resolveDiscount(body);
    if (!discount.ok) return errorResponse("VALIDATION_ERROR", discount.message);
    const termClash = termPeriodsForbidMultiCycle(discount.discount.duration, body.allowedPeriods);
    if (termClash) return errorResponse("VALIDATION_ERROR", termClash);

    const startsAt = body.startsAt ?? new Date().toISOString();
    const endsAt = body.endsAt ?? null;
    if (endsAt !== null && new Date(endsAt) <= new Date(startsAt)) {
      return errorResponse("VALIDATION_ERROR", "The end date must come after the start date");
    }

    const maxRedemptions = body.maxRedemptions ?? null;
    const stripeIds = await createPromotionCoupon({
      code,
      name: body.name,
      tiers: body.allowedTiers,
      discount: discount.discount,
      // Nothing has been redeemed yet, so the balance is the whole cap.
      remainingRedemptions: maxRedemptions
    });

    let promotion: PromotionRow;
    try {
      promotion = await createPromotion({
        code,
        name: body.name,
        percentOff: discount.discount.percentOff,
        amountOffCents: discount.discount.amountOffCents,
        duration: discount.discount.duration,
        durationInMonths: discount.discount.durationInMonths,
        allowedTiers: body.allowedTiers,
        allowedPeriods: body.allowedPeriods,
        startsAt,
        endsAt,
        maxRedemptions,
        active: body.active,
        stripeCouponId: stripeIds.couponId,
        stripePromotionCodeId: stripeIds.promotionCodeId,
        createdBy: admin.email ?? admin.userId
      });
    } catch (err) {
      // The Stripe objects exist but nothing points at them. Take them back
      // out so a retried submit can reuse the same customer-facing code.
      try {
        await deletePromotionCoupon(stripeIds);
      } catch (cleanupErr) {
        logger.warn("promotions: Stripe cleanup failed after a rejected insert", {
          code,
          couponId: stripeIds.couponId,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        });
      }
      throw err;
    }

    // Keep Stripe in step with a promotion created switched off.
    if (!body.active) await setPromotionCodeActive(stripeIds.promotionCodeId, false);

    return successResponse({ promotion });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

export async function GET() {
  try {
    await requireAdmin();
    const [promotions, businesses] = await Promise.all([
      listPromotionsWithStats(),
      listBusinesses()
    ]);
    const nameById = new Map(businesses.map((b) => [b.id, b.name]));
    return successResponse({
      promotions: promotions.map((promotion) => ({
        ...promotion,
        redemptions: promotion.redemptions.map((row) => ({
          ...row,
          business_name: nameById.get(row.business_id) ?? null
        }))
      }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * Undo a coupon replacement whose row write did not land.
 *
 * Without this the two sides disagree in the worst direction: the row still
 * names the OLD Stripe ids, but the old promotion code was switched off to
 * free the code string, so validation would keep accepting the promo while
 * Stripe refused the discount at checkout. Switching the abandoned new code
 * off and the stored one back on restores exactly the pre-edit state.
 *
 * No-op when the edit never touched Stripe. Best-effort: it runs while an
 * error is already being surfaced, so a failure here is logged rather than
 * masking the original fault.
 */
async function rollBackCouponReplacement(
  current: PromotionRow,
  stripePatch: { stripePromotionCodeId?: string }
): Promise<void> {
  if (!stripePatch.stripePromotionCodeId) return;
  try {
    await setPromotionCodeActive(stripePatch.stripePromotionCodeId, false);
    await setPromotionCodeActive(current.stripe_promotion_code_id, current.active);
  } catch (err) {
    logger.error("promotions: Stripe left ahead of the row after a failed edit", {
      promotionId: current.id,
      code: current.code,
      storedPromotionCodeId: current.stripe_promotion_code_id,
      abandonedPromotionCodeId: stripePatch.stripePromotionCodeId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = patchSchema.parse(await request.json());

    const current = await getPromotion(body.promotionId);
    if (!current) return errorResponse("NOT_FOUND", "Promotion not found");

    const discount = resolveDiscount(body, current);
    if (!discount.ok) return errorResponse("VALIDATION_ERROR", discount.message);
    const effectivePeriods = body.allowedPeriods ?? current.allowed_periods;
    const termClash = termPeriodsForbidMultiCycle(discount.discount.duration, effectivePeriods);
    if (termClash) return errorResponse("VALIDATION_ERROR", termClash);

    const allowedTiers = body.allowedTiers ?? current.allowed_tiers;
    const maxRedemptions =
      body.maxRedemptions !== undefined ? body.maxRedemptions : current.max_redemptions;
    const startsAt = body.startsAt ?? current.starts_at;
    const endsAt = body.endsAt !== undefined ? body.endsAt : current.ends_at;
    if (endsAt !== null && new Date(endsAt) <= new Date(startsAt)) {
      return errorResponse("VALIDATION_ERROR", "The end date must come after the start date");
    }

    const stripePatch: { stripeCouponId?: string; stripePromotionCodeId?: string } = {};
    if (needsCouponReplacement(current, discount.discount, allowedTiers, maxRedemptions)) {
      const replacement = await replacePromotionCoupon({
        previous: {
          couponId: current.stripe_coupon_id,
          promotionCodeId: current.stripe_promotion_code_id
        },
        code: current.code,
        name: body.name ?? current.name,
        tiers: allowedTiers,
        discount: discount.discount,
        // The replacement counts from zero, so Stripe gets the balance.
        remainingRedemptions: remainingRedemptions(
          maxRedemptions,
          await countPromotionRedemptions(current.id)
        )
      });
      stripePatch.stripeCouponId = replacement.couponId;
      stripePatch.stripePromotionCodeId = replacement.promotionCodeId;
      // A replacement is minted active; a promotion that is switched off (or
      // being switched off in this same edit) must not come back live.
      const willBeActive = body.active ?? current.active;
      if (!willBeActive) await setPromotionCodeActive(replacement.promotionCodeId, false);
    } else if (body.active !== undefined && body.active !== current.active) {
      await setPromotionCodeActive(current.stripe_promotion_code_id, body.active);
    }

    let promotion: PromotionRow | null;
    try {
      promotion = await updatePromotion(body.promotionId, {
        name: body.name,
        percentOff: discount.discount.percentOff,
        amountOffCents: discount.discount.amountOffCents,
        duration: discount.discount.duration,
        durationInMonths: discount.discount.durationInMonths,
        allowedTiers,
        allowedPeriods: body.allowedPeriods,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        maxRedemptions: body.maxRedemptions,
        active: body.active,
        ...stripePatch
      });
    } catch (err) {
      await rollBackCouponReplacement(current, stripePatch);
      throw err;
    }
    if (!promotion) {
      await rollBackCouponReplacement(current, stripePatch);
      return errorResponse("NOT_FOUND", "Promotion not found");
    }

    return successResponse({ promotion });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

const deleteSchema = z.object({ promotionId: z.string().uuid() });

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    const body = deleteSchema.parse(await request.json());

    const current = await getPromotion(body.promotionId);
    if (!current) return errorResponse("NOT_FOUND", "Promotion not found");

    if ((await countPromotionRedemptions(current.id)) > 0) {
      return errorResponse(
        "CONFLICT",
        "This promotion has been redeemed, so it can only be switched off. Deleting it would erase the redemption history."
      );
    }

    await deletePromotion(current.id);
    // Row first, and the Stripe teardown is best-effort after it. The row is
    // the authority every redemption reads, so once it is gone the code is
    // already dead; a leftover coupon is inert and not worth failing the
    // request over (the admin would just retry into a 404).
    try {
      await deletePromotionCoupon({
        couponId: current.stripe_coupon_id,
        promotionCodeId: current.stripe_promotion_code_id
      });
    } catch (err) {
      logger.warn("promotions: Stripe objects outlived a deleted promotion", {
        code: current.code,
        couponId: current.stripe_coupon_id,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
