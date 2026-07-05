/**
 * Persistence for `webhook_subscriptions` — Zapier-style REST hooks. The
 * webhook-dispatcher Edge cron reads/advances these rows; this module is
 * the management surface used by /api/public/v1/hooks.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { WebhookEventType } from "../../../supabase/functions/_shared/webhook_events";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WebhookSubscriptionRow = {
  id: string;
  business_id: string;
  event: WebhookEventType;
  target_url: string;
  active: boolean;
  last_cursor: string;
  /** Tiebreak id for rows sharing last_cursor's timestamp (nil uuid = none). */
  last_cursor_id: string;
  consecutive_failures: number;
  api_key_id: string | null;
  created_at: string;
};

/** Cap per business — Zapier makes one hook per Zap; 25 is generous. */
export const MAX_HOOKS_PER_BUSINESS = 25;

export async function createWebhookSubscription(
  input: {
    businessId: string;
    event: WebhookEventType;
    targetUrl: string;
    apiKeyId?: string | null;
  },
  client?: SupabaseClient
): Promise<WebhookSubscriptionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webhook_subscriptions")
    .insert({
      business_id: input.businessId,
      event: input.event,
      target_url: input.targetUrl,
      api_key_id: input.apiKeyId ?? null
    })
    .select()
    .single();
  if (error) throw new Error(`createWebhookSubscription: ${error.message}`);
  return data as WebhookSubscriptionRow;
}

export async function listWebhookSubscriptions(
  businessId: string,
  client?: SupabaseClient
): Promise<WebhookSubscriptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webhook_subscriptions")
    .select("*")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listWebhookSubscriptions: ${error.message}`);
  return (data as WebhookSubscriptionRow[] | null) ?? [];
}

export async function countActiveWebhookSubscriptions(
  businessId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("webhook_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("active", true);
  if (error) throw new Error(`countActiveWebhookSubscriptions: ${error.message}`);
  return count ?? 0;
}

/**
 * Hard-delete a subscription (Zapier unsubscribes on Zap off; keeping dead
 * rows would only confuse the dashboard). Business-scoped. Returns false
 * when nothing matched.
 */
export async function deleteWebhookSubscription(
  businessId: string,
  subscriptionId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("webhook_subscriptions")
    .delete()
    .eq("id", subscriptionId)
    .eq("business_id", businessId)
    .select("id");
  if (error) throw new Error(`deleteWebhookSubscription: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length > 0;
}
