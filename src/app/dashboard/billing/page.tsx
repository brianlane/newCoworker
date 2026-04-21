/**
 * /dashboard/billing
 *
 * Tenant-facing billing page. Shows:
 *   - current plan + included usage line
 *   - Stripe-period voice balance (included headroom + bonus remaining, via
 *     `getVoiceBillingSnapshotForBusiness`)
 *   - self-serve voice-bonus top-up packs at `VOICE_BONUS_USD_PER_MINUTE`
 *   - "Manage billing" button → Stripe Customer Portal (reuses existing
 *     `/api/billing/portal`)
 *
 * Bonus purchase requires an active subscription row; the API enforces the
 * same check so the UI is just an early nudge.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import {
  getVoiceBonusUsdPerMinute,
  listVoiceBonusPacks
} from "@/lib/billing/voice-bonus-packs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { VoiceBonusPacks } from "@/components/dashboard/VoiceBonusPacks";

export const dynamic = "force-dynamic";

type SearchParams = { bonus?: string };

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
    .select("id, tier, enterprise_limits, name")
    .eq("owner_email", user.email)
    .limit(1);

  const business = businesses?.[0] ?? null;
  const subscription = business ? await getSubscription(business.id) : null;
  const snapshot = business ? await getVoiceBillingSnapshotForBusiness(business.id) : null;

  const packs = listVoiceBonusPacks();
  const usdPerMinute = getVoiceBonusUsdPerMinute();

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

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Billing</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Plan, voice minutes, and top-up packs
        </p>
      </div>

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
              bonusBanner.kind === "ok"
                ? "text-sm text-claw-green"
                : "text-sm text-spark-orange"
            }
          >
            {bonusBanner.text}
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Subscription</h2>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-parchment/50">Plan</dt>
            <dd>
              <Badge variant={business?.tier === "standard" ? "online" : "neutral"}>
                {business?.tier ?? "—"}
              </Badge>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-parchment/50">Status</dt>
            <dd>
              <Badge variant={subscription?.status === "active" ? "success" : "pending"}>
                {subscription?.status ?? "—"}
              </Badge>
            </dd>
          </div>
          {business?.tier && (
            <div className="pt-2 border-t border-parchment/10">
              <dt className="text-parchment/50 text-xs mb-1">Included usage</dt>
              <dd className="text-xs text-parchment/60 leading-relaxed">
                {voiceMinutesLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined
                )}
                <br />
                {smsMonthlyLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined
                )}
              </dd>
            </div>
          )}
        </dl>

        {subscription?.stripe_customer_id && (
          <form action="/api/billing/portal" method="POST" className="mt-4">
            <button
              type="submit"
              className="text-sm text-claw-green hover:underline"
            >
              Manage billing and payment methods →
            </button>
          </form>
        )}
      </Card>

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
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                Bonus balance
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment">
                {formatMinutes(snapshot.bonusSecondsAvailable)}
              </dd>
              <dd className="text-[11px] text-parchment/40">
                unused top-up minutes
              </dd>
            </div>
            <div>
              <dt className="text-xs text-parchment/50 uppercase tracking-wider">
                Top-up rate
              </dt>
              <dd className="mt-1 text-lg font-semibold text-parchment font-mono">
                ${usdPerMinute.toFixed(2)}/min
              </dd>
              <dd className="text-[11px] text-parchment/40">
                flat rate, any pack size
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
