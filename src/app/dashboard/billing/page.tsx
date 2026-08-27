/**
 * /dashboard/billing
 *
 * Tenant-facing billing page. Rebuilt for the subscription lifecycle
 * overhaul to surface:
 *   - <PlanCard>: tier, billing period, status badge, next renewal /
 *     period-end / grace-wipe date, cancel / undo / reactivate buttons,
 *     inline upgrade/downgrade selector.
 *   - <GraceBanner>: only when canceled-in-grace, warns about the wipe
 *     deadline and offers a single reactivate CTA.
 *   - Voice balance + bonus packs (unchanged).
 *
 * Eligibility math (refund-window + change-plan abuse cap) is computed
 * server-side from the LifecycleContext so the client never needs to
 * re-derive it.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription, isCommitmentElapsed } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import {
  calendarMonthResetAt,
  formatUsagePeriodDate,
  monthlyUsageResetAt
} from "@/lib/billing/usage-period";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";
import type { PlanTier } from "@/lib/plans/tier";
import {
  getVoiceBonusBestUsdPerMinute,
  listVoiceBonusPacks
} from "@/lib/billing/voice-bonus-packs";
import { listSmsBonusPacks } from "@/lib/billing/sms-bonus-packs";
import { listChatCreditPacks } from "@/lib/billing/chat-credit-packs";
import {
  listMembershipPackAddonOptions,
  membershipPackSelectionFromRow
} from "@/lib/billing/membership-pack-addons";
import {
  getChatSpendSnapshotForBusiness,
  getSmsBonusSoonestExpiry,
  getSmsBonusTextsRemaining
} from "@/lib/db/chat-usage";
import { getBillingWindowUsageTotals } from "@/lib/db/usage";
import { effectiveSmsMonthlyCap } from "@/lib/plans/limits";
import {
  getAutoReloadCard,
  listAutoReloadEvents,
  listAutoReloadRules
} from "@/lib/db/auto-reload";
import {
  AutoReloadSettings,
  type AutoReloadCategoryView
} from "@/components/billing/AutoReloadSettings";
import {
  getCustomerProfileById,
  isWithinLifetimeRefundWindow,
  LIFETIME_SUBSCRIPTION_CAP
} from "@/lib/db/customer-profiles";
import { Card } from "@/components/ui/Card";
import { VoiceBonusPacks } from "@/components/dashboard/VoiceBonusPacks";
import { UsagePacks } from "@/components/dashboard/UsagePacks";
import { listWhiteGloveOffers } from "@/lib/db/white-glove-offers";
import { PlanCard } from "@/components/billing/PlanCard";
import {
  getWhiteGloveBookingUrl,
  getWhiteGlovePackage,
  hasPrioritySupportForTier,
  listWhiteGlovePackages
} from "@/lib/plans/white-glove";
import { PrioritySupportCard } from "@/components/billing/PrioritySupportCard";
import { getLivePrioritySupportSubscription } from "@/lib/db/priority-support";
import {
  PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD,
  PRIORITY_SUPPORT_MONTHLY_CENTS,
  prioritySupportDaysLeft,
  prioritySupportCardState as resolvePrioritySupportCardState
} from "@/lib/plans/priority-support";
import { formatPriceCents } from "@/lib/pricing";
// Same operator channels the enterprise dedicated-support card uses: a paying
// priority customer reaches us the same way an enterprise tenant does.
import { getEnterpriseSupportContact } from "@/lib/plans/enterprise-support";

export const dynamic = "force-dynamic";

type SearchParams = {
  bonus?: string;
  planChanged?: string;
  reactivated?: string;
  whiteGlove?: string;
  prioritySupport?: string;
};

function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  const minutes = Math.round(seconds / 60);
  return `${minutes.toLocaleString()} min`;
}

export default async function BillingPage(props: {
  searchParams?: Promise<SearchParams>;
}) {
  const t = await getTranslations("dashboard.billing");
  const locale = (await getLocale()) as AppLocale;
  const searchParams = (await props.searchParams) ?? {};
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/billing");
  if (!user.email) redirect("/login?redirectTo=/dashboard/billing");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, tier, enterprise_limits, name, customer_profile_id, white_glove_package, white_glove_purchased_at, priority_support_until, phone, timezone"
    )
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);

  const business = businesses?.[0] ?? null;

  // Everything below keys only on the business id, so it all runs as ONE
  // parallel batch instead of the previous sequential awaits (subscription →
  // snapshot → … → offers was 4+ serial round-trips). The SMS + Gemini usage
  // meters are read-only display (enforcement lives in the workers / RPCs)
  // and are individually non-fatal for the page.
  const [
    subscription,
    snapshot,
    smsWindowUsed,
    smsBonusRemaining,
    smsBonusExpiresAt,
    chatSpend,
    allCustomOffers,
    autoReloadRules,
    autoReloadCard,
    autoReloadEvents,
    prioritySupportRow
  ] = business
    ? await Promise.all([
        getSubscription(business.id),
        getVoiceBillingSnapshotForBusiness(business.id),
        getBillingWindowUsageTotals(business.id, db)
          // Cap surface: text UNITS, ceiled (matches the reserve RPC's ledger;
          // analytics keeps message counts via sms_sent elsewhere).
          .then((t) => Math.ceil(t.sms_text_units))
          .catch(() => null),
        getSmsBonusTextsRemaining(business.id, db),
        getSmsBonusSoonestExpiry(business.id, db).catch(() => null),
        getChatSpendSnapshotForBusiness(
          business.id,
          db,
          (business.tier ?? null) as PlanTier | null
        ).catch(() => null),
        // Custom admin-authored offers (bespoke price, single business).
        listWhiteGloveOffers(business.id, db),
        // Auto-reload reads are individually non-fatal: a failure here must
        // not blank the whole billing page.
        listAutoReloadRules(business.id, db).catch(() => []),
        getAutoReloadCard(business.id, db).catch(() => null),
        listAutoReloadEvents(business.id, 5, db).catch(() => []),
        // Same non-fatal treatment: the priority support card is an add-on,
        // and losing it must not blank the page a tenant came here to read.
        getLivePrioritySupportSubscription(business.id, db).catch(() => null)
      ])
    : [
        null,
        null,
        null,
        0,
        null,
        null,
        [] as Awaited<ReturnType<typeof listWhiteGloveOffers>>,
        [] as Awaited<ReturnType<typeof listAutoReloadRules>>,
        null,
        [] as Awaited<ReturnType<typeof listAutoReloadEvents>>,
        null
      ];

  // Prefer `business.customer_profile_id` over `subscription.customer_profile_id`
  // when the subscription is in a terminal state (canceled or wiped),
  // because:
  //   * `subscriptions.customer_profile_id` is stamped at row creation and
  //     never automatically re-keyed when the customer's profile is
  //     remapped (e.g. /api/billing/change-plan upserts a fresh profile
  //     and stamps `business.customer_profile_id` but cannot retroactively
  //     update older subscription rows).
  //   * `businesses.customer_profile_id` IS actively maintained by
  //     /api/billing/reactivate, /api/admin/force-refund, and
  //     /api/billing/change-plan (each upserts by owner email and writes
  //     the resolved id back to the business row).
  // For an active subscription, the two values agree (both are written
  // by the orchestrator's atomic write), so it doesn't matter which
  // we read first; we keep subscription-first for that case so this is
  // a strictly minor change for the common path.
  //
  // Also use `??` consistently (instead of mixed `||` / `??`) so an
  // unexpected empty-string id (vanishingly rare for a uuid column,
  // but defensible) doesn't cause us to attempt a `getCustomerProfileById("")`
  // lookup.
  const subIsTerminal =
    subscription?.status === "canceled" || Boolean(subscription?.wiped_at);
  const resolvedProfileId = subIsTerminal
    ? (business?.customer_profile_id ?? subscription?.customer_profile_id ?? null)
    : (subscription?.customer_profile_id ?? business?.customer_profile_id ?? null);
  const profile = resolvedProfileId
    ? await getCustomerProfileById(resolvedProfileId)
    : null;

  const packs = listVoiceBonusPacks();
  const usdPerMinute = getVoiceBonusBestUsdPerMinute(packs);
  const smsPacks = listSmsBonusPacks();
  const chatPacks = listChatCreditPacks();
  const packAddonOptions = listMembershipPackAddonOptions();
  // What the tenant already carries, so change-plan starts from their current
  // packs instead of an empty selection (which silently dropped them).
  const currentPackAddons = membershipPackSelectionFromRow(
    subscription?.membership_pack_addons ?? null
  );

  const smsMonthlyCap = business?.tier
    ? effectiveSmsMonthlyCap(
        business.tier as PlanTier,
        business.tier === "enterprise" ? business.enterprise_limits : undefined,
        { phone: business.phone ?? null, timezone: business.timezone ?? null }
      )
    : null;

  const canPurchase = Boolean(
    subscription?.stripe_subscription_id && subscription.status === "active"
  );

  // One auto-reload section per family. Thresholds and balances stay in
  // canonical units here; the component converts for display.
  const autoReloadByCategory = new Map(autoReloadRules.map((r) => [r.category, r]));
  const autoReloadViews: AutoReloadCategoryView[] = (
    [
      {
        category: "voice" as const,
        packs: packs.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          grantUnits: p.seconds
        })),
        currentUnits: snapshot
          ? snapshot.includedHeadroomSeconds + snapshot.bonusSecondsAvailable
          : null,
        unavailable: null
      },
      {
        category: "sms" as const,
        packs: smsPacks.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          grantUnits: p.texts
        })),
        currentUnits:
          smsMonthlyCap !== null && Number.isFinite(smsMonthlyCap)
            ? Math.max(0, smsMonthlyCap - (smsWindowUsed ?? 0)) + smsBonusRemaining
            : null,
        // An infinite plan cap can never be crossed, so a remaining-capacity
        // threshold is meaningless rather than merely large.
        unavailable:
          smsMonthlyCap !== null && !Number.isFinite(smsMonthlyCap)
            ? ("uncapped_sms" as const)
            : null
      },
      {
        category: "chat" as const,
        packs: chatPacks.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          grantUnits: p.creditMicros
        })),
        // Chat credit raises the cap rather than being consumed, so the
        // meaningful number is headroom under the effective cap.
        currentUnits: chatSpend
          ? Math.max(0, chatSpend.effectiveCapMicros - chatSpend.spendMicros)
          : null,
        unavailable: null
      }
    ] as const
  ).map((base) => {
    const rule = autoReloadByCategory.get(base.category);
    return {
      category: base.category,
      enabled: rule?.enabled ?? false,
      packId: rule?.packId ?? null,
      thresholdUnits: rule?.thresholdUnits ?? null,
      monthlyLimitCents: rule?.monthlyLimitCents ?? null,
      packs: base.packs,
      currentUnits: base.currentUnits,
      unavailableReason: !canPurchase
        ? ("no_subscription" as const)
        : base.packs.length === 0
          ? ("no_packs" as const)
          : base.unavailable,
      pausedReason: rule?.pausedReason ?? null,
      disabledReason: rule?.disabledReason ?? null
    };
  });
  let disabledReason: string | null = null;
  if (!canPurchase) {
    disabledReason = business ? t("requiresActive") : t("noBusiness");
  }

  const bonusBanner =
    searchParams.bonus === "success"
      ? { kind: "ok" as const, text: t("bonusSuccess") }
      : searchParams.bonus === "cancelled"
        ? { kind: "warn" as const, text: t("checkoutCancelled") }
        : null;

  const planChangedBanner =
    searchParams.planChanged === "1"
      ? { kind: "ok" as const, text: t("planChanged") }
      : null;
  const reactivatedBanner =
    searchParams.reactivated === "1"
      ? { kind: "ok" as const, text: t("reactivated") }
      : null;
  const whiteGloveBanner =
    searchParams.whiteGlove === "success"
      ? { kind: "ok" as const, text: t("whiteGloveSuccess") }
      : searchParams.whiteGlove === "cancelled"
        ? { kind: "warn" as const, text: t("checkoutCancelled") }
        : null;
  const prioritySupportBanner =
    searchParams.prioritySupport === "success"
      ? { kind: "ok" as const, text: t("prioritySupport.started") }
      : searchParams.prioritySupport === "cancelled"
        ? { kind: "warn" as const, text: t("prioritySupport.checkoutCancelled") }
        : null;

  // ---- White-glove onboarding (Phase C5) --------------------------------
  const ownedWhiteGlove = getWhiteGlovePackage(
    (business as { white_glove_package?: string | null } | null)?.white_glove_package ?? ""
  );
  const prioritySupportUntilIso =
    (business as { priority_support_until?: string | null } | null)?.priority_support_until ?? null;
  // Enterprise tenants hold a PERMANENT priority window (SLA bullet);
  // others get the 30-day white-glove purchase window.
  const isEnterpriseTier = (business as { tier?: string | null } | null)?.tier === "enterprise";
  const priorityOpen = hasPrioritySupportForTier(
    (business as { tier?: string | null } | null)?.tier,
    prioritySupportUntilIso
  );
  const bookingUrl = getWhiteGloveBookingUrl();

  // ---- Priority support add-on ($400/month, its own Stripe subscription) --
  // Enterprise never sees the card: their window is permanent and free, and
  // the Support card above already says so.
  const prioritySupportDays = prioritySupportDaysLeft(
    (business as { tier?: string | null } | null)?.tier,
    prioritySupportUntilIso
  );
  const prioritySupportCardState = resolvePrioritySupportCardState({
    subscription: prioritySupportRow,
    tier: (business as { tier?: string | null } | null)?.tier,
    prioritySupportUntilIso
  });
  const prioritySupportCoverageLabel =
    prioritySupportUntilIso && prioritySupportCardState !== "none"
      ? new Date(prioritySupportUntilIso).toLocaleDateString(
          locale === "es" ? "es-US" : "en-US",
          { month: "long", day: "numeric", year: "numeric" }
        )
      : null;
  const prioritySupportPriceLabel = formatPriceCents(PRIORITY_SUPPORT_MONTHLY_CENTS);
  // Only OPEN custom offers are payable; paid/revoked rows never render here
  // (fetched in the parallel batch above).
  const customWhiteGloveOffers = allCustomOffers.filter((o) => o.status === "open");
  // A business that has ALREADY received white-glove service, any fixed
  // package, or a paid custom offer, never sees the package upsell again
  // (not even the setup → buildout upgrade).
  const hasReceivedWhiteGlove =
    ownedWhiteGlove !== null || allCustomOffers.some((o) => o.status === "paid");
  const whiteGloveOffers = hasReceivedWhiteGlove ? [] : listWhiteGlovePackages(locale);

  // ---- Derive PlanCard props from subscription + profile ---------------
  const now = new Date();

  // ONE reset date for every included allowance. Voice minutes, texts, and the
  // AI chat budget all refill on the month-window anchored to the Stripe
  // period start (see @/lib/billing/usage-period, and the
  // sms_window_anchored_to_billing_period migration for the text side). On a
  // 12/24-month prepaid plan that is NOT the renewal date PlanCard shows
  // above: the term renews once, the allowances refill every month.
  //
  // Bonus packs are the exception and keep their own per-grant expiry.
  const nowMs = now.getTime();
  const usageResetAt =
    monthlyUsageResetAt(subscription?.stripe_current_period_start ?? null, nowMs) ??
    // No usable Stripe anchor: every meter falls back to the UTC calendar
    // month, matching sms_billing_window_start and
    // getChatSpendSnapshotForBusiness.
    calendarMonthResetAt(nowMs);
  const fmtPeriodDate = (iso: string) => formatUsagePeriodDate(iso, locale);
  const planStatus: "active" | "active_cancel_at_period_end" | "canceled_in_grace" | "pending" | "canceled" | "wiped" =
    !subscription
      ? "canceled"
      : subscription.wiped_at
        ? "wiped"
        : subscription.status === "canceled" && subscription.grace_ends_at &&
            new Date(subscription.grace_ends_at).getTime() > now.getTime()
          ? "canceled_in_grace"
          : subscription.status === "active" && subscription.cancel_at_period_end
            ? "active_cancel_at_period_end"
            : subscription.status === "active"
              ? "active"
              : subscription.status === "pending"
                ? "pending"
                : "canceled";

  const withinRefundWindow = profile ? isWithinLifetimeRefundWindow(profile, now) : false;
  const refundUsed = Boolean(profile?.refund_used_at);
  const canRefund =
    (planStatus === "active" || planStatus === "active_cancel_at_period_end") &&
    withinRefundWindow &&
    !refundUsed;
  const refundBlockedReason = refundUsed
    ? t("refundUsed")
    : !profile
      ? t("refundUnverified")
      : !withinRefundWindow
      ? t("refundWindowPassed")
      : null;

  // "Next renewal" is the live Stripe current_period_end for active subs
  // (rolls forward each cycle), falling back to the cached value / renewal_at.
  // The resolver only hits Stripe when the cached period end is missing or
  // already elapsed, so the common case stays a zero-network-call render.
  const renewalAt =
    planStatus === "active"
      ? await resolveActiveRenewalDate(subscription)
      : (subscription?.renewal_at ?? null);

  const lifetimeCount = profile?.lifetime_subscription_count ?? 0;
  const capReached = lifetimeCount >= LIFETIME_SUBSCRIPTION_CAP;
  const canChangePlan = planStatus === "active" && !capReached;
  const changePlanBlockedReason = capReached
    ? t("capReached")
    : planStatus !== "active"
      ? t("changePlanInactive")
      : null;

  // Term-contract extras: auto-renew toggle while the commitment is running,
  // "start a new contract" CTA once it has elapsed (rolled to month-to-month).
  // Server-side change-plan re-validates elapsed-ness before honoring a
  // same-plan re-contract, so this is display-only eligibility.
  const commitmentElapsed = subscription
    ? Boolean(subscription.stripe_subscription_id) && isCommitmentElapsed(subscription, now)
    : false;
  const contractAutoRenew = Boolean(subscription?.contract_auto_renew);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("title")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("subtitle")}</p>
      </div>

      {planChangedBanner && (
        <Card className="border-claw-green/40 bg-claw-green/10">
          <p className="text-sm text-claw-green">{planChangedBanner.text}</p>
        </Card>
      )}

      {reactivatedBanner && (
        <Card className="border-claw-green/40 bg-claw-green/10">
          <p className="text-sm text-claw-green">{reactivatedBanner.text}</p>
        </Card>
      )}

      {whiteGloveBanner && (
        <Card
          className={
            whiteGloveBanner.kind === "ok"
              ? "border-claw-green/40 bg-claw-green/10"
              : "border-spark-orange/40 bg-spark-orange/10"
          }
        >
          <p
            className={
              whiteGloveBanner.kind === "ok"
                ? "text-sm text-claw-green"
                : "text-sm text-spark-orange"
            }
          >
            {whiteGloveBanner.text}
          </p>
        </Card>
      )}

      {prioritySupportBanner && (
        <Card
          className={
            prioritySupportBanner.kind === "ok"
              ? "border-claw-green/40 bg-claw-green/10"
              : "border-spark-orange/40 bg-spark-orange/10"
          }
        >
          <p
            className={
              prioritySupportBanner.kind === "ok"
                ? "text-sm text-claw-green"
                : "text-sm text-spark-orange"
            }
          >
            {prioritySupportBanner.text}
          </p>
        </Card>
      )}

      {bonusBanner && (
        <Card
          className={
            bonusBanner.kind === "ok"
              ? "border-claw-green/40 bg-claw-green/10"
              : "border-spark-orange/40 bg-spark-orange/10"
          }
        >
          <p
            className={
              bonusBanner.kind === "ok" ? "text-sm text-claw-green" : "text-sm text-spark-orange"
            }
          >
            {bonusBanner.text}
          </p>
        </Card>
      )}

      <PlanCard
        tier={(business?.tier ?? null) as PlanTier | null}
        billingPeriod={subscription?.billing_period ?? null}
        status={planStatus}
        renewalAt={renewalAt}
        periodEnd={subscription?.stripe_current_period_end ?? null}
        graceEndsAt={subscription?.grace_ends_at ?? null}
        canRefund={canRefund}
        refundBlockedReason={refundBlockedReason}
        canChangePlan={canChangePlan}
        changePlanBlockedReason={changePlanBlockedReason}
        stripeCustomerId={subscription?.stripe_customer_id ?? null}
        contractAutoRenew={contractAutoRenew}
        commitmentElapsed={commitmentElapsed}
        packAddonOptions={packAddonOptions}
        currentPackAddons={currentPackAddons}
        // An operator-applied discount, so the card does not quote a plan the
        // owner is no longer paying in full. Mirrored from Stripe by
        // /api/admin/membership-discount and the subscription webhook.
        discount={
          subscription
            ? {
                discount_coupon_id: subscription.discount_coupon_id,
                discount_name: subscription.discount_name,
                discount_percent_off: subscription.discount_percent_off,
                discount_amount_off_cents: subscription.discount_amount_off_cents,
                discount_duration: subscription.discount_duration,
                discount_duration_in_months: subscription.discount_duration_in_months,
                discount_started_at: subscription.discount_started_at,
                discount_ends_at: subscription.discount_ends_at
              }
            : null
        }
      />

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">{t("voiceBalance")}</h2>
        {snapshot ? (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                {t("includedLeft")}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {formatMinutes(snapshot.includedHeadroomSeconds)}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {t("capUsed", {
                  cap: formatMinutes(snapshot.tierCapSeconds),
                  used: formatMinutes(snapshot.committedIncludedSeconds)
                })}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {t("resetsOn", { date: fmtPeriodDate(usageResetAt) })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">{t("bonusBalance")}</dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {formatMinutes(snapshot.bonusSecondsAvailable)}
              </dd>
              <dd className="text-[11px] text-parchment/40">{t("unusedTopUps")}</dd>
              {snapshot.bonusSoonestExpiresAt && (
                <dd className="text-[11px] text-parchment/40">
                  {t("bonusNextExpiry", {
                    date: fmtPeriodDate(snapshot.bonusSoonestExpiresAt)
                  })}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">{t("topUpRate")}</dt>
              <dd className="mt-1 text-lg font-semibold text-parchment font-mono">
                {t("fromPerMin", { rate: `$${usdPerMinute.toFixed(2)}` })}
              </dd>
              <dd className="text-[11px] text-parchment/40">{t("bestRate")}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-parchment/50">{t("voiceBalancePending")}</p>
        )}
      </Card>

      <VoiceBonusPacks
        packs={packs}
        usdPerMinute={usdPerMinute}
        canPurchase={canPurchase}
        disabledReason={disabledReason}
      />

      {business && (
        <Card>
          <h2 className="text-sm font-semibold text-parchment mb-4">{t("messagingAiUsage")}</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                {t("textsSentThisMonth")}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {smsWindowUsed === null ? "–" : smsWindowUsed.toLocaleString()}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {smsMonthlyCap === null || smsMonthlyCap === Infinity
                  ? t("noMonthlyCap")
                  : t("planCapPerMonth", { cap: smsMonthlyCap.toLocaleString() })}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {t("resetsOn", { date: fmtPeriodDate(usageResetAt) })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                {t("bonusTextsRemaining")}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {smsBonusRemaining.toLocaleString()}
              </dd>
              <dd className="text-[11px] text-parchment/40">{t("usedAfterCap")}</dd>
              {smsBonusExpiresAt && (
                <dd className="text-[11px] text-parchment/40">
                  {t("bonusNextExpiry", { date: fmtPeriodDate(smsBonusExpiresAt) })}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">{t("aiChatBudget")}</dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {chatSpend
                  ? `$${(chatSpend.spendMicros / 1_000_000).toFixed(2)} / $${(chatSpend.effectiveCapMicros / 1_000_000).toFixed(2)}`
                  : "–"}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {chatSpend && chatSpend.creditMicros > 0
                  ? t("includesPurchasedCredit", {
                      credit: `$${(chatSpend.creditMicros / 1_000_000).toFixed(2)}`
                    })
                  : t("sharedAcrossTasks")}
              </dd>
              {chatSpend && (
                <dd className="text-[11px] text-parchment/40">
                  {t("resetsOn", { date: fmtPeriodDate(usageResetAt) })}
                </dd>
              )}
            </div>
          </dl>
        </Card>
      )}

      <UsagePacks
        title={t("buyMoreTexts")}
        description={t("buyMoreTextsBlurb")}
        checkoutPath="/api/billing/sms-bonus/checkout"
        packs={smsPacks.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          subline: t("perText", { rate: `$${p.effectiveUsdPerText.toFixed(3)}` })
        }))}
        canPurchase={canPurchase}
        disabledReason={disabledReason}
      />

      <UsagePacks
        title={t("buyChatCredit")}
        description={t("buyChatCreditBlurb")}
        checkoutPath="/api/billing/chat-credit/checkout"
        packs={chatPacks.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          subline: t("addsToBudget", { credit: `$${p.creditUsd.toFixed(2)}` })
        }))}
        canPurchase={canPurchase}
        disabledReason={disabledReason}
      />

      <AutoReloadSettings
        categories={autoReloadViews}
        recentEvents={autoReloadEvents.map((e) => ({
          id: e.id,
          category: e.category,
          createdAt: e.createdAt,
          status: e.status,
          amountCents: e.amountCents,
          packLabel: e.packId,
          failureMessage: e.failureMessage
        }))}
        card={
          autoReloadCard && !autoReloadCard.revokedAt
            ? { brand: autoReloadCard.cardBrand, last4: autoReloadCard.cardLast4 }
            : null
        }
        hasRecurringPacks={Boolean(
          currentPackAddons.voicePacks?.length ||
            currentPackAddons.smsPacks?.length ||
            currentPackAddons.chatPacks?.length
        )}
      />

      <Card>
        <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">{t("support")}</h2>
        {hasReceivedWhiteGlove ? (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-parchment/70">
              {(ownedWhiteGlove?.name ??
                allCustomOffers.find((o) => o.status === "paid")?.name ??
                t("whiteGloveService"))}{" "}
              {t("purchased")}{" "}
              {isEnterpriseTier
                ? t("enterprisePriority")
                : priorityOpen && prioritySupportUntilIso
                  ? t("priorityOpenUntil", {
                      date: new Date(prioritySupportUntilIso).toLocaleDateString(
                        locale === "es" ? "es-US" : "en-US",
                        { month: "long", day: "numeric", year: "numeric" }
                      )
                    })
                  : t("priorityEnded")}
            </p>
            {priorityOpen && bookingUrl && (
              <p className="text-xs text-parchment/50">
                {t("bookSession")}{" "}
                <a
                  href={bookingUrl}
                  className="text-claw-green underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("schedulingLink")}
                </a>
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs text-parchment/50">{t("emailSupportUpsell")}</p>
        )}
      </Card>

      {/* The $400/month add-on. Hidden for Enterprise, whose priority window
          is permanent and included, so the Support card above is the whole
          story for them and this would be selling them what they have. */}
      {!isEnterpriseTier && (
        <PrioritySupportCard
          state={prioritySupportCardState}
          daysLeft={prioritySupportDays}
          coverageEndsLabel={prioritySupportCoverageLabel}
          priceLabel={prioritySupportPriceLabel}
          lowDays={
            prioritySupportDays !== null &&
            prioritySupportDays <= PRIORITY_SUPPORT_LOW_DAYS_THRESHOLD
          }
          contact={getEnterpriseSupportContact()}
        />
      )}

      {/* Deliberately unpriced (matches the public /pricing card): interest
          routes to the contact form as a sales lead and a specialist quotes
          from there. Only admin-authored custom offers below are payable. */}
      {whiteGloveOffers.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">
            {t("whiteGloveTitle")}
          </h2>
          <p className="mt-1 text-xs text-parchment/50">{t("whiteGloveBlurb")}</p>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {whiteGloveOffers.map((pkg) => (
              <div
                key={pkg.id}
                className="rounded-lg border border-parchment/15 bg-deep-ink/40 p-4 flex flex-col gap-2"
              >
                <p className="text-xs text-parchment/50 uppercase tracking-wider">{pkg.name}</p>
                <p className="text-[11px] text-parchment/40">{pkg.description}</p>
                <Link
                  href="/contact?topic=white-glove"
                  className="mt-auto inline-flex items-center justify-center rounded-md bg-claw-green px-3 py-1.5 text-sm font-semibold text-deep-ink transition-all duration-150 hover:bg-claw-green/90"
                >
                  {t("contactUs")}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      )}

      {customWhiteGloveOffers.length > 0 && (
        <UsagePacks
          title={t("customOfferTitle")}
          description={t("customOfferBlurb")}
          checkoutPath="/api/billing/white-glove/checkout"
          packs={customWhiteGloveOffers.map((o) => ({
            id: o.id,
            label: o.name,
            priceUsd: o.amount_cents / 100,
            subline: o.description || undefined
          }))}
          canPurchase={canPurchase}
          disabledReason={disabledReason}
        />
      )}
    </div>
  );
}
