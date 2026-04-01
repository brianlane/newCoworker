import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { BillingPeriod } from "@/lib/plans/tier";

export type { BillingPeriod };

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SubscriptionRow = {
  id: string;
  business_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  tier: "starter" | "standard" | "enterprise";
  status: "active" | "past_due" | "canceled" | "pending";
  billing_period: BillingPeriod | null;
  renewal_at: string | null;
  commitment_months: number | null;
  created_at: string;
};

export async function createSubscription(
  data: Omit<SubscriptionRow, "created_at" | "billing_period" | "renewal_at" | "commitment_months"> & {
    billing_period?: BillingPeriod | null;
    renewal_at?: string | null;
    commitment_months?: number | null;
  },
  client?: SupabaseClient
): Promise<SubscriptionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("subscriptions")
    .insert(data)
    .select()
    .single();

  if (error) throw new Error(`createSubscription: ${error.message}`);
  return row as SubscriptionRow;
}

export async function getSubscription(
  businessId: string,
  client?: SupabaseClient
): Promise<SubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) return null;
  return data as SubscriptionRow;
}

export async function getSubscriptionByStripeSubscriptionId(
  stripeSubscriptionId: string,
  client?: SupabaseClient
): Promise<SubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error) return null;
  return data as SubscriptionRow;
}

export async function listSubscriptionsByBusinessIds(
  businessIds: string[],
  client?: SupabaseClient
): Promise<Map<string, SubscriptionRow>> {
  if (businessIds.length === 0) return new Map();
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("subscriptions")
    .select()
    .in("business_id", businessIds)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listSubscriptionsByBusinessIds: ${error.message}`);

  const map = new Map<string, SubscriptionRow>();
  for (const row of (data ?? []) as SubscriptionRow[]) {
    if (!map.has(row.business_id)) {
      map.set(row.business_id, row);
    }
  }
  return map;
}

export async function updateSubscription(
  id: string,
  update: Partial<Pick<SubscriptionRow, "status" | "stripe_subscription_id" | "stripe_customer_id">>,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("subscriptions").update(update).eq("id", id);
  if (error) throw new Error(`updateSubscription: ${error.message}`);
}
