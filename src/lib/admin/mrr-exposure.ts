/**
 * Refund-exposure stamping for the admin MRR cards.
 *
 * A subscription's revenue is REFUND-EXPOSED while the owner can still take
 * the lifetime-once 30-day money-back refund: their customer profile's
 * window is open and unused ({@link isWithinLifetimeRefundWindow} — the
 * exact gate `/api/billing/cancel` enforces) AND the placement is
 * self-serve refundable (`vps_provider` resolves to `hostinger`; BYOS/OVH
 * placements are refused by the cancel route's placement gate). Everyone
 * else can only cancel at period end, which keeps the already-paid month.
 *
 * `computeDayCurrentMrr` reads the stamped `refund_exposed` flag and splits
 * `totalCents` into `refundExposedCents` + `committedCents` so the admin
 * dashboard/revenue cards can show MRR with and without first-month
 * refund risk.
 */

import {
  listCustomerProfilesByIds,
  isWithinLifetimeRefundWindow,
  type CustomerProfileRow
} from "@/lib/db/customer-profiles";
import { resolveVpsProvider } from "@/lib/vps/provider";
import type { MrrSubscriptionInput } from "@/lib/admin/mrr";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** The extra fields exposure stamping needs beyond the MRR inputs. */
export type RefundExposureSubscription = MrrSubscriptionInput & {
  business_id: string;
  customer_profile_id: string | null;
};

/**
 * Pure join: stamp `refund_exposed` on each subscription from preloaded
 * profiles + business providers. No profile → not exposed (the self-serve
 * refund planner refuses those with `missing_context`).
 */
export function stampRefundExposure<T extends RefundExposureSubscription>(
  subscriptions: T[],
  data: {
    profilesById: Map<string, Pick<CustomerProfileRow, "first_paid_at" | "refund_used_at">>;
    /** Raw `businesses.vps_provider` per business id; absent → hostinger. */
    vpsProviderByBusinessId: Map<string, string | null>;
    now?: Date;
  }
): Array<T & { refund_exposed: boolean }> {
  const now = data.now ?? new Date();
  return subscriptions.map((sub) => {
    const profile = sub.customer_profile_id
      ? data.profilesById.get(sub.customer_profile_id) ?? null
      : null;
    const refundablePlacement =
      resolveVpsProvider(data.vpsProviderByBusinessId.get(sub.business_id)) === "hostinger";
    return {
      ...sub,
      refund_exposed:
        refundablePlacement && profile !== null && isWithinLifetimeRefundWindow(profile, now)
    };
  });
}

/**
 * Production loader: batch-load the customer profiles behind the given
 * subscriptions and stamp exposure. Only profiles that could possibly
 * matter are fetched — active, Stripe-backed, non-enterprise rows are the
 * only ones `computeDayCurrentMrr` counts.
 */
export async function stampRefundExposureFromDb<T extends RefundExposureSubscription>(
  subscriptions: T[],
  businesses: Array<{ id: string; vps_provider?: string | null }>,
  opts: { now?: Date; client?: SupabaseClient } = {}
): Promise<Array<T & { refund_exposed: boolean }>> {
  const profileIds = [
    ...new Set(
      subscriptions
        .filter(
          (sub) =>
            sub.status === "active" &&
            sub.stripe_subscription_id !== null &&
            sub.tier !== "enterprise" &&
            sub.customer_profile_id !== null
        )
        .map((sub) => sub.customer_profile_id as string)
    )
  ];
  const profilesById = await listCustomerProfilesByIds(profileIds, opts.client);
  const vpsProviderByBusinessId = new Map(
    businesses.map((b) => [b.id, b.vps_provider ?? null])
  );
  return stampRefundExposure(subscriptions, {
    profilesById,
    vpsProviderByBusinessId,
    now: opts.now
  });
}
