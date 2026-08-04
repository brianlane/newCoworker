/**
 * POST /api/billing/auto-reload
 *
 * Body: `{ category, enabled, packId, thresholdUnits, monthlyLimitCents? }`
 *
 * Saves one family's auto-reload rule. Enabling requires an authorized card:
 * the membership card was collected under a subscription mandate, which does
 * not cover ad-hoc merchant-initiated top-ups, so the first enable returns a
 * hosted `mode: "setup"` Checkout URL and the client redirects. The rule is
 * still saved in that case, so the tenant's choices survive the round trip and
 * the sweep simply skips a rule with no card behind it.
 */
import { z } from "zod";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getSubscription } from "@/lib/db/subscriptions";
import { createAutoReloadSetupSession } from "@/lib/stripe/client";
import {
  AUTO_RELOAD_CATEGORIES,
  AUTO_RELOAD_DEFAULT_COOLDOWN_MINUTES,
  AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS,
  validateAutoReload
} from "@/lib/billing/auto-reload";
import {
  getAutoReloadCard,
  listAutoReloadRules,
  upsertAutoReloadRule
} from "@/lib/db/auto-reload";
import { getTranslations } from "next-intl/server";
import { logger } from "@/lib/logger";

const bodySchema = z.object({
  category: z.enum(AUTO_RELOAD_CATEGORIES),
  enabled: z.boolean(),
  packId: z.string().trim().min(1).max(40),
  thresholdUnits: z.number().int().positive().max(100_000_000),
  monthlyLimitCents: z
    .number()
    .int()
    .positive()
    .max(AUTO_RELOAD_MAX_MONTHLY_LIMIT_CENTS)
    .nullable()
    .optional()
});

/** Tenant-facing message per validation failure. */
const ERROR_MESSAGE: Record<string, string> = {
  unknown_pack: "That pack is not available",
  threshold_out_of_range: "That threshold is outside the allowed range",
  threshold_not_below_pack: "The threshold must be smaller than the pack you picked",
  monthly_limit_below_pack_price: "The monthly limit must cover at least one pack",
  monthly_limit_out_of_range: "That monthly limit is outside the allowed range",
  monthly_limit_required: "Set a monthly limit before turning on AI credit auto-reload"
};

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only, and this route arms real money movement.
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) {
      return errorResponse("FORBIDDEN", "Authentication required", 403);
    }

    const payload = bodySchema.parse(await request.json());
    const monthlyLimitCents = payload.monthlyLimitCents ?? null;

    const t = await getTranslations("dashboard.billing.autoReload");
    const businessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
    if (!businessId) return errorResponse("NOT_FOUND", "Business not found", 404);

    const validation = validateAutoReload({
      category: payload.category,
      enabled: payload.enabled,
      packId: payload.packId,
      thresholdUnits: payload.thresholdUnits,
      monthlyLimitCents
    });
    if (!validation.ok) {
      return errorResponse(
        "VALIDATION_ERROR",
        ERROR_MESSAGE[validation.error] ?? "Invalid auto-reload settings",
        400
      );
    }

    const db = await createSupabaseServiceClient();
    const sub = await getSubscription(businessId, db);

    // Turning auto-reload OFF must always work, even on a lapsed
    // subscription; only arming it needs a live membership.
    if (payload.enabled && (!sub || sub.status !== "active" || !sub.stripe_subscription_id)) {
      return errorResponse("CONFLICT", "No active subscription to configure", 409);
    }

    // A chargeback is the customer saying they did not expect the charge.
    // Everything else clears on save, but re-arming after a dispute is a
    // support decision, and the billing page copy says so.
    if (payload.enabled) {
      const existing = (await listAutoReloadRules(businessId, db)).find(
        (r) => r.category === payload.category
      );
      if (existing?.disabledReason === "dispute") {
        return errorResponse(
          "CONFLICT",
          "Auto-reload is blocked after a disputed charge; contact support",
          409
        );
      }
    }

    const rule = await upsertAutoReloadRule(
      businessId,
      {
        category: payload.category,
        enabled: payload.enabled,
        packId: validation.pack.packId,
        thresholdUnits: payload.thresholdUnits,
        monthlyLimitCents,
        cooldownMinutes: AUTO_RELOAD_DEFAULT_COOLDOWN_MINUTES[payload.category]
      },
      db
    );

    // The rule is saved either way; the card is what the sweep gates on.
    let setupUrl: string | null = null;
    if (payload.enabled) {
      const card = await getAutoReloadCard(businessId, db);
      if (!card || card.revokedAt) {
        if (!sub?.stripe_customer_id) {
          return errorResponse(
            "CONFLICT",
            "No billing account on file; contact support",
            409
          );
        }
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
        const session = await createAutoReloadSetupSession({
          customerId: sub.stripe_customer_id,
          businessId,
          userId: user.userId,
          successUrl: `${appUrl}/dashboard/billing?autoReload=ready`,
          cancelUrl: `${appUrl}/dashboard/billing?autoReload=canceled`,
          consentNote: t("consentStripeNote")
        });
        setupUrl = session.url;
      }
    }

    logger.info("auto-reload settings saved", {
      businessId,
      category: payload.category,
      enabled: payload.enabled,
      packId: validation.pack.packId,
      needsCard: setupUrl !== null
    });

    return successResponse({ rule, needsCard: setupUrl !== null, setupUrl });
  } catch (err) {
    return handleRouteError(err);
  }
}
