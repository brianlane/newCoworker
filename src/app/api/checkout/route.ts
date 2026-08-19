import { authUserExistsByEmail, getAuthUser, verifySignupIdentity } from "@/lib/auth";
import { createCheckoutSession, resolveIntroDiscountCouponId, resolvePriceId } from "@/lib/stripe/client";
import { createSubscription, findCheckoutBlockingSubscription } from "@/lib/db/subscriptions";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { coerceOwnerPhoneToE164 } from "@/lib/phone/e164";
import { verifyOnboardingToken, createPendingOwnerEmail } from "@/lib/onboarding/token";
import {
  getBusiness,
  listBusinessIdsByOwnerEmail,
  setBusinessCustomerProfile,
  updateBusinessPhone
} from "@/lib/db/businesses";
import {
  LIFETIME_SUBSCRIPTION_CAP,
  upsertCustomerProfile,
  getCustomerProfileById
} from "@/lib/db/customer-profiles";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getCommitmentMonths, renewalDateAfterMonths } from "@/lib/plans/tier";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import { CANADA_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/canadian-messaging";
import { MEXICO_MESSAGING_FEE_MONTHLY_CENTS } from "@/lib/plans/mexican-messaging";
import { resolveBusinessCountry } from "@/lib/plans/business-country";
import { getOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { validatePromotionCode } from "@/lib/promotions/validate";
import { resolveMembershipPackAddons } from "@/lib/billing/membership-pack-addons";

const schema = z.object({
  tier: z.enum(["starter", "standard"]),
  businessId: z.string().uuid(),
  billingPeriod: z.enum(["monthly", "annual", "biennial"]).default("biennial"),
  ownerEmail: z.string().email().optional(),
  onboardingToken: z.string().min(1).optional(),
  signupUserId: z.string().uuid().optional(),
  draftToken: z.string().uuid().optional(),
  /**
   * Browser IANA timezone, used ONLY as the fallback signal for the
   * Canadian-surcharge detection when the business row has no stored
   * timezone (the phone is always authoritative when NANP). Keeps the
   * order-summary preview and the actual charge in lockstep.
   */
  timezone: z.string().min(1).max(60).optional(),
  /**
   * Admin promotion the customer entered on Step 3. Re-validated here against
   * the same rules the preview ran (`validatePromotionCode`), so the summary
   * and the charge cannot diverge and a forged preview buys nothing.
   */
  promoCode: z.string().trim().min(1).max(40).optional(),
  /** Optional recurring usage-pack add-ons (quantity per catalog SKU). */
  voicePacks: z
    .array(
      z.object({
        packId: z.string().trim().min(1).max(40),
        quantity: z.number().int().min(1).max(20)
      })
    )
    .max(10)
    .optional(),
  smsPacks: z
    .array(
      z.object({
        packId: z.string().trim().min(1).max(40),
        quantity: z.number().int().min(1).max(20)
      })
    )
    .max(10)
    .optional(),
  chatPacks: z
    .array(
      z.object({
        packId: z.string().trim().min(1).max(40),
        quantity: z.number().int().min(1).max(20)
      })
    )
    .max(10)
    .optional()
});

/**
 * Best-effort signup IP: prefers the left-most (client) value of
 * `x-forwarded-for`, falls back to `x-real-ip`, otherwise `null`. The IP is
 * stored on the customer profile for abuse correlation only, a missing or
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
        // session bound to an email that ALREADY has an auth user,
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
    // subscription from the onboarding flow. If the posted business, or any
    // business the signed-in user owns, already has live/paid service
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
    // `checkout.session.completed`, not here, so abandoned checkouts
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
      // timeout, etc.), proceeding would silently bypass the lifetime
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

    // Promo code. Fails CLOSED: a code that no longer validates (switched off,
    // capped out, window closed since the customer previewed it) refuses the
    // checkout rather than silently charging full price on a session the
    // customer expects to be discounted. 422 is the client's signal to drop
    // the code and retry at the normal price.
    let promotion: Awaited<ReturnType<typeof validatePromotionCode>> | null = null;
    if (body.promoCode) {
      promotion = await validatePromotionCode({
        code: body.promoCode,
        tier: body.tier,
        period: body.billingPeriod
      });
      if (!promotion.ok) {
        logger.info("checkout: promo code rejected at redemption time", {
          businessId: body.businessId,
          reason: promotion.reason
        });
        return errorResponse(
          "VALIDATION_ERROR",
          "That promo code is no longer valid for this plan. Remove it and continue at the regular price.",
          422
        );
      }
    }

    // Canadian signups pay the labeled monthly messaging surcharge (Canadian
    // carriers charge per-message pass-through fees US traffic doesn't).
    // Detection uses the phone + timezone the owner entered at onboarding,
    // the same phone that biases their coworker number purchase, so the fee
    // and the CA-enabled messaging capability travel together. A missing
    // business row fails toward NOT charging.
    const feeBusiness = await getBusiness(body.businessId);
    // Retry path: a Stripe-cancel return re-mints the session WITHOUT
    // re-running /api/business/create, so the row's phone can be stale if
    // the owner edited it on Step 1 before retrying. The questionnaire syncs
    // the draft (token-verified) with the CURRENT form values immediately
    // before calling this route, so the draft phone is the same value the
    // order summary previewed the fee with, prefer it AND write it back to
    // the row, so provisioning (which classifies from the row) buys the
    // number in the same country the fee was billed for. Best-effort: any
    // draft read/write failure falls back to the row.
    let draftPhone: string | null = null;
    if (body.draftToken) {
      // `candidate` feeds fee CLASSIFICATION (free-form ok: an uncoercible
      // value just falls through to the timezone signal). `syncable` gates
      // the row WRITE: /api/business/create now persists only coerced E.164,
      // and this retry path must not re-write legacy-draft junk over it.
      let candidate: string | null = null;
      let syncable: string | null = null;
      try {
        const draft = await getOnboardingDraft(body.businessId, body.draftToken);
        const p = (draft?.payload as { phone?: unknown } | null)?.phone;
        const raw = typeof p === "string" && p.trim() ? p : null;
        syncable = coerceOwnerPhoneToE164(raw);
        candidate = syncable ?? raw;
      } catch (err) {
        logger.warn("checkout: draft read for country-fee detection failed (using business row)", {
          businessId: body.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      if (syncable && feeBusiness && syncable !== feeBusiness.phone) {
        try {
          await updateBusinessPhone(body.businessId, syncable);
          draftPhone = syncable;
        } catch (err) {
          // Billing must classify from the same value provisioning will read.
          // If the row couldn't be synced, keep classifying from the (stale)
          // row rather than billing a Canadian fee against a US provisioning
          // run (or vice versa).
          logger.warn("checkout: business phone sync failed; classifying from the stored row", {
            businessId: body.businessId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      } else if (candidate) {
        // Same as the row (or no row exists): nothing to sync.
        draftPhone = candidate;
      }
    }
    // Classified EXACTLY ONCE from exactly these values; provisioning reads
    // the same row, so the fee, the messaging profile, and the DID country
    // can never diverge (the four-Bugbot-round lesson from the Canada
    // rollout). `country` is three-way: CA adds the Canadian surcharge, MX
    // adds the Mexican surcharge AND skips the US carrier fee.
    const country = resolveBusinessCountry({
      phone: draftPhone ?? feeBusiness?.phone ?? null,
      // Stored row timezone first; the caller-supplied browser timezone only
      // fills a null (older rows predating the timezone column), so the
      // Step 3 order-summary preview and the charge can't diverge. A client
      // omitting it can only fail toward NOT being charged.
      timezone: feeBusiness?.timezone ?? body.timezone ?? null
    });
    const canadian = country === "CA";
    const mexican = country === "MX";
    const now = new Date();
    const renewalAt = renewalDateAfterMonths(now, commitmentMonths);

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

    const packAddons = resolveMembershipPackAddons(
      {
        voicePacks: body.voicePacks,
        smsPacks: body.smsPacks,
        chatPacks: body.chatPacks
      },
      body.billingPeriod
    );
    if (!packAddons.ok) {
      return errorResponse("VALIDATION_ERROR", packAddons.error, 422);
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
      // Wins over the intro coupon inside createCheckoutSession (Stripe allows
      // one discount per session), matching what the order summary previewed.
      ...(promotion?.ok
        ? { discountPromotionCodeId: promotion.promotion.stripe_promotion_code_id }
        : {}),
      // New signups register a fresh 10DLC campaign, pass the carrier fee
      // through as a one-time line item. Plan changes and reactivations
      // (separate routes) keep the existing campaign and never re-charge it.
      // Mexican signups skip the CHARGE (10DLC/TCR is a US-carrier
      // registration cost that cannot apply to their +52 traffic) while
      // their US DID still attaches to the shared campaign, so any texts
      // they do send to US handsets stay deliverable; that per-number
      // marginal cost is absorbed into the Mexican surcharge.
      oneTimeCarrierFeeCents: mexican ? 0 : CARRIER_REGISTRATION_FEE_CENTS,
      ...(canadian
        ? {
            canadaFee: {
              monthlyCents: CANADA_MESSAGING_FEE_MONTHLY_CENTS,
              billingPeriod: body.billingPeriod
            }
          }
        : {}),
      ...(mexican
        ? {
            mexicoFee: {
              monthlyCents: MEXICO_MESSAGING_FEE_MONTHLY_CENTS,
              billingPeriod: body.billingPeriod
            }
          }
        : {}),
      ...(packAddons.lines.length > 0
        ? {
            packAddonLines: packAddons.lines.map((line) => ({
              name: line.name,
              unitAmountCents: line.unitAmountCents,
              quantity: line.quantity,
              billingPeriod: body.billingPeriod
            }))
          }
        : {}),
      metadata: {
        businessId: body.businessId,
        tier: body.tier,
        billingPeriod: body.billingPeriod,
        userId: metadataUserId,
        // Rides subscription_data.metadata so change-plan can tell whether
        // the sub it is replacing carried the surcharge (grandfathered
        // pre-fee tenants never get it added on a later plan change).
        ...(canadian ? { canadianMessagingFee: "1" } : {}),
        ...(mexican ? { mexicanMessagingFee: "1" } : {}),
        // The webhook files the redemption from this id; the code rides along
        // so a Stripe session is legible without a join.
        ...(promotion?.ok
          ? { promotionId: promotion.promotion.id, promotionCode: promotion.promotion.code }
          : {}),
        ...(customerProfileId ? { customerProfileId } : {}),
        ...packAddons.metadata
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
