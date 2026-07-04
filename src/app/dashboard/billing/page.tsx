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

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription, isCommitmentElapsed } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import {
  getVoiceBonusBestUsdPerMinute,
  listVoiceBonusPacks
} from "@/lib/billing/voice-bonus-packs";
import { listSmsBonusPacks } from "@/lib/billing/sms-bonus-packs";
import { listChatCreditPacks } from "@/lib/billing/chat-credit-packs";
import {
  getChatSpendSnapshotForBusiness,
  getSmsBonusTextsRemaining
} from "@/lib/db/chat-usage";
import { getCalendarMonthUsageTotals } from "@/lib/db/usage";
import { getTierLimits } from "@/lib/plans/limits";
import {
  getCustomerProfileById,
  isWithinLifetimeRefundWindow,
  LIFETIME_SUBSCRIPTION_CAP
} from "@/lib/db/customer-profiles";
import { Card } from "@/components/ui/Card";
import { VoiceBonusPacks } from "@/components/dashboard/VoiceBonusPacks";
import { UsagePacks } from "@/components/dashboard/UsagePacks";
import { PlanCard } from "@/components/billing/PlanCard";
import {
  getWhiteGloveBookingUrl,
  getWhiteGlovePackage,
  hasPrioritySupport,
  listWhiteGlovePackages
} from "@/lib/plans/white-glove";

export const dynamic = "force-dynamic";

type SearchParams = {
  bonus?: string;
  planChanged?: string;
  reactivated?: string;
  whiteGlove?: string;
};

function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  const minutes = Math.round(seconds / 60);
  return `${minutes.toLocaleString()} min`;
}

export default async function BillingPage(props: {
  searchParams?: Promise<SearchParams>;
}) {
  const searchParams = (await props.searchParams) ?? {};
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/billing");
  if (!user.email) redirect("/login?redirectTo=/dashboard/billing");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, tier, enterprise_limits, name, customer_profile_id, white_glove_package, white_glove_purchased_at, priority_support_until"
    )
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);

  const business = businesses?.[0] ?? null;
  const subscription = business ? await getSubscription(business.id) : null;
  const snapshot = business ? await getVoiceBillingSnapshotForBusiness(business.id) : null;

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

  // SMS + Gemini usage meters (read-only display; enforcement lives in the
  // workers / RPCs). Each read is independent and non-fatal for the page.
  let smsMonthUsed: number | null = null;
  let smsBonusRemaining = 0;
  let chatSpend: Awaited<ReturnType<typeof getChatSpendSnapshotForBusiness>> | null = null;
  if (business) {
    [smsMonthUsed, smsBonusRemaining, chatSpend] = await Promise.all([
      getCalendarMonthUsageTotals(business.id, db)
        .then((t) => t.sms_sent)
        .catch(() => null),
      getSmsBonusTextsRemaining(business.id, db),
      getChatSpendSnapshotForBusiness(
        business.id,
        db,
        (business.tier ?? null) as PlanTier | null
      ).catch(() => null)
    ]);
  }
  const smsMonthlyCap = business?.tier
    ? getTierLimits(
        business.tier as PlanTier,
        business.tier === "enterprise" ? business.enterprise_limits : undefined
      ).smsPerMonth
    : null;

  const canPurchase = Boolean(
    subscription?.stripe_subscription_id && subscription.status === "active"
  );
  let disabledReason: string | null = null;
  if (!canPurchase) {
    disabledReason = business
      ? "Bonus minutes require an active subscription. Finish setup or reactivate your plan to unlock top-ups."
      : "No business linked to this account yet.";
  }

  const bonusBanner =
    searchParams.bonus === "success"
      ? { kind: "ok" as const, text: "Thanks! Your bonus minutes will appear once Stripe confirms the payment." }
      : searchParams.bonus === "cancelled"
        ? { kind: "warn" as const, text: "Checkout cancelled. No charge was made." }
        : null;

  const planChangedBanner =
    searchParams.planChanged === "1"
      ? {
          kind: "ok" as const,
          text: "Plan change submitted. We're migrating your workspace to the new VPS — this can take a few minutes."
        }
      : null;
  const reactivatedBanner =
    searchParams.reactivated === "1"
      ? {
          kind: "ok" as const,
          text: "Reactivation submitted. We're restoring your workspace onto a fresh VPS — this can take a few minutes."
        }
      : null;
  const whiteGloveBanner =
    searchParams.whiteGlove === "success"
      ? {
          kind: "ok" as const,
          text: "Thanks! Your white-glove onboarding is confirmed — check your email for the booking link."
        }
      : searchParams.whiteGlove === "cancelled"
        ? { kind: "warn" as const, text: "Checkout cancelled. No charge was made." }
        : null;

  // ---- White-glove onboarding (Phase C5) --------------------------------
  const ownedWhiteGlove = getWhiteGlovePackage(
    (business as { white_glove_package?: string | null } | null)?.white_glove_package ?? ""
  );
  const prioritySupportUntilIso =
    (business as { priority_support_until?: string | null } | null)?.priority_support_until ?? null;
  const priorityOpen = hasPrioritySupport(prioritySupportUntilIso);
  const bookingUrl = getWhiteGloveBookingUrl();
  // Offer only packages the business doesn't already own (buildout supersedes
  // setup, so owning buildout hides both offers; owning setup leaves the
  // buildout upgrade visible).
  const whiteGloveOffers = listWhiteGlovePackages().filter(
    (p) => ownedWhiteGlove === null || (ownedWhiteGlove.id === "setup" && p.id === "buildout")
  );

  // ---- Derive PlanCard props from subscription + profile ---------------
  const now = new Date();
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
    ? "You've already used your one-time lifetime refund."
    : !profile
      ? "We couldn't verify your lifetime refund eligibility. Contact support if you believe this is wrong."
      : !withinRefundWindow
      ? "Your 30-day money-back window has passed."
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
    ? "You've reached the maximum number of subscription lifetimes for this account."
    : planStatus !== "active"
      ? "Plan changes are only available on an active subscription."
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
        <h1 className="text-2xl font-bold text-parchment">Billing</h1>
        <p className="text-sm text-parchment/50 mt-1">Plan, voice minutes, and top-up packs</p>
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
      />

      {business?.tier && (
        <Card>
          <h2 className="text-sm font-semibold text-parchment mb-3">Included usage</h2>
          <p className="text-xs text-parchment/60 leading-relaxed">
            {voiceMinutesLine(
              business.tier as PlanTier,
              business.tier === "enterprise" ? business.enterprise_limits : undefined
            )}
            <br />
            {smsMonthlyLine(
              business.tier as PlanTier,
              business.tier === "enterprise" ? business.enterprise_limits : undefined
            )}
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Voice balance</h2>
        {snapshot ? (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                Included left this period
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {formatMinutes(snapshot.includedHeadroomSeconds)}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                cap {formatMinutes(snapshot.tierCapSeconds)} · used{" "}
                {formatMinutes(snapshot.committedIncludedSeconds)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">Bonus balance</dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {formatMinutes(snapshot.bonusSecondsAvailable)}
              </dd>
              <dd className="text-[11px] text-parchment/40">unused top-up minutes</dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">Top-up rate</dt>
              <dd className="mt-1 text-lg font-semibold text-parchment font-mono">
                from ${usdPerMinute.toFixed(2)}/min
              </dd>
              <dd className="text-[11px] text-parchment/40">
                best effective rate; see packs below
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-parchment/50">
            Voice balance will appear here once your subscription period is active.
          </p>
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
          <h2 className="text-sm font-semibold text-parchment mb-4">Messaging &amp; AI usage</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                Texts sent this month
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {smsMonthUsed === null ? "—" : smsMonthUsed.toLocaleString()}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {smsMonthlyCap === null || smsMonthlyCap === Infinity
                  ? "no monthly cap on your plan"
                  : `plan cap ${smsMonthlyCap.toLocaleString()}/month`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                Bonus texts remaining
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {smsBonusRemaining.toLocaleString()}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                used automatically after the plan cap
              </dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">AI chat budget</dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {chatSpend
                  ? `$${(chatSpend.spendMicros / 1_000_000).toFixed(2)} / $${(chatSpend.effectiveCapMicros / 1_000_000).toFixed(2)}`
                  : "—"}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                {chatSpend && chatSpend.creditMicros > 0
                  ? `includes $${(chatSpend.creditMicros / 1_000_000).toFixed(2)} purchased credit`
                  : "shared across all agentic tasks"}
              </dd>
            </div>
          </dl>
        </Card>
      )}

      <UsagePacks
        title="Buy more texts"
        description="Bonus texts kick in after your plan's monthly allowance and expire at the later of your current billing period end or 30 days after purchase."
        checkoutPath="/api/billing/sms-bonus/checkout"
        packs={smsPacks.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          subline: `$${p.effectiveUsdPerText.toFixed(3)}/text`
        }))}
        canPurchase={canPurchase}
        disabledReason={disabledReason}
      />

      <UsagePacks
        title="Buy AI chat credit"
        description="Credit raises this period's shared AI budget, so replies stay on the cloud model instead of falling back to the local model."
        checkoutPath="/api/billing/chat-credit/checkout"
        packs={chatPacks.map((p) => ({
          id: p.id,
          label: p.label,
          priceUsd: p.priceUsd,
          subline: `adds $${p.creditUsd.toFixed(2)} to this period's budget`
        }))}
        canPurchase={canPurchase}
        disabledReason={disabledReason}
      />

      <Card>
        <h2 className="text-sm font-semibold text-parchment uppercase tracking-wider">Support</h2>
        {ownedWhiteGlove ? (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-parchment/70">
              {ownedWhiteGlove.name} purchased.{" "}
              {priorityOpen && prioritySupportUntilIso
                ? `Priority call & video support is open until ${new Date(prioritySupportUntilIso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
                : "Your priority call & video window has ended — support continues by email."}
            </p>
            {priorityOpen && bookingUrl && (
              <p className="text-xs text-parchment/50">
                Book a session anytime:{" "}
                <a
                  href={bookingUrl}
                  className="text-claw-green underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  scheduling link
                </a>
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs text-parchment/50">
            Your plan includes email support. Add white-glove onboarding below for live call
            &amp; video support with a specialist.
          </p>
        )}
      </Card>

      {whiteGloveOffers.length > 0 && (
        <UsagePacks
          title="White-glove onboarding"
          description="One-time, hands-on onboarding with a specialist. Either package opens a 30-day priority call & video support line."
          checkoutPath="/api/billing/white-glove/checkout"
          packs={whiteGloveOffers.map((p) => ({
            id: p.id,
            label: p.name,
            priceUsd: p.priceUsd,
            subline: p.description
          }))}
          canPurchase={canPurchase}
          disabledReason={disabledReason}
        />
      )}
    </div>
  );
}
