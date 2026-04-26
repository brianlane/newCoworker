/**
 * Immutable audit trail for subscription refunds.
 *
 * Written by the lifecycle engine after Stripe confirms a refund has been
 * issued (stripe_refund_id is the unique key). Separate from voice-bonus
 * clawbacks, which live on `voice_bonus_grants.voided_*` columns.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SubscriptionRefundReason =
  | "thirty_day_money_back"
  | "admin_force"
  | "dispute_lost";

export type SubscriptionRefundRow = {
  id: string;
  subscription_id: string;
  customer_profile_id: string | null;
  stripe_refund_id: string;
  stripe_charge_id: string | null;
  amount_cents: number;
  currency: string;
  reason: SubscriptionRefundReason;
  created_at: string;
};

export async function recordSubscriptionRefund(
  input: {
    subscriptionId: string;
    customerProfileId: string | null;
    stripeRefundId: string;
    stripeChargeId: string | null;
    amountCents: number;
    currency?: string;
    reason: SubscriptionRefundReason;
  },
  client?: SupabaseClient
): Promise<SubscriptionRefundRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscription_refunds")
    .insert({
      subscription_id: input.subscriptionId,
      customer_profile_id: input.customerProfileId,
      stripe_refund_id: input.stripeRefundId,
      stripe_charge_id: input.stripeChargeId,
      amount_cents: input.amountCents,
      currency: input.currency ?? "usd",
      reason: input.reason
    })
    .select()
    .single();
  if (error) {
    // Idempotent: duplicate stripe_refund_id is fine — look up the existing row.
    if (error.code === "23505") {
      const { data: existing, error: readErr } = await db
        .from("subscription_refunds")
        .select()
        .eq("stripe_refund_id", input.stripeRefundId)
        .single();
      if (readErr || !existing) {
        throw new Error(`recordSubscriptionRefund: duplicate but lookup failed (${readErr?.message})`);
      }
      return existing as SubscriptionRefundRow;
    }
    throw new Error(`recordSubscriptionRefund: ${error.message}`);
  }
  return data as SubscriptionRefundRow;
}

export async function listRefundsForSubscription(
  subscriptionId: string,
  client?: SupabaseClient
): Promise<SubscriptionRefundRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscription_refunds")
    .select()
    .eq("subscription_id", subscriptionId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listRefundsForSubscription: ${error.message}`);
  return (data ?? []) as SubscriptionRefundRow[];
}
