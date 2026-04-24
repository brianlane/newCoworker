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
import { getSubscription } from "@/lib/db/subscriptions";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import {
  getVoiceBonusBestUsdPerMinute,
  listVoiceBonusPacks
} from "@/lib/billing/voice-bonus-packs";
import {
  getCustomerProfileById,
  isWithinLifetimeRefundWindow,
  LIFETIME_SUBSCRIPTION_CAP
} from "@/lib/db/customer-profiles";
import { Card } from "@/components/ui/Card";
import { VoiceBonusPacks } from "@/components/dashboard/VoiceBonusPacks";
import { PlanCard } from "@/components/billing/PlanCard";

export const dynamic = "force-dynamic";

type SearchParams = { bonus?: string; planChanged?: string; reactivated?: string };

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
    .select("id, tier, enterprise_limits, name, customer_profile_id")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);

  const business = businesses?.[0] ?? null;
  const subscription = business ? await getSubscription(business.id) : null;
  const snapshot = business ? await getVoiceBillingSnapshotForBusiness(business.id) : null;

  const profile =
    subscription?.customer_profile_id || business?.customer_profile_id
      ? await getCustomerProfileById(
          (subscription?.customer_profile_id ?? business?.customer_profile_id) as string
        )
      : null;

  const packs = listVoiceBonusPacks();
  const usdPerMinute = getVoiceBonusBestUsdPerMinute(packs);

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

  const lifetimeCount = profile?.lifetime_subscription_count ?? 0;
  const capReached = lifetimeCount >= LIFETIME_SUBSCRIPTION_CAP;
  const canChangePlan = planStatus === "active" && !capReached;
  const changePlanBlockedReason = capReached
    ? "You've reached the maximum number of subscription lifetimes for this account."
    : planStatus !== "active"
      ? "Plan changes are only available on an active subscription."
      : null;

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
        renewalAt={subscription?.renewal_at ?? null}
        periodEnd={subscription?.stripe_current_period_end ?? null}
        graceEndsAt={subscription?.grace_ends_at ?? null}
        canRefund={canRefund}
        refundBlockedReason={refundBlockedReason}
        canChangePlan={canChangePlan}
        changePlanBlockedReason={changePlanBlockedReason}
        stripeCustomerId={subscription?.stripe_customer_id ?? null}
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
    </div>
  );
}
