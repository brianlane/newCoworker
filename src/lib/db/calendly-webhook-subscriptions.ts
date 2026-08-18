/**
 * Persistence for `calendly_webhook_subscriptions`, the record of the
 * Calendly invitee.created webhook fast path.
 *
 * One row per CONNECTION (a business can link several Calendly accounts,
 * and each account's subscription carries its own signing key; the
 * receiver verifies a delivery against every candidate row for the
 * business), upserted by the lifecycle module
 * (src/lib/calendly/webhook-subscriptions.ts):
 *   - status 'active' carries the subscription URI plus the signing key
 *     the platform minted and supplied at creation (encrypted at rest, same
 *     crypto as calendly_connections), the receiver decrypts it to verify
 *     the Calendly-Webhook-Signature header;
 *   - status 'unsupported' / 'error' records a refused/failed attempt with
 *     its timestamp, so the sweep only re-tries on a long cooldown.
 *
 * Service-role only: RLS is on with no policies. The decrypted signing key
 * never leaves server-side code.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type CalendlyWebhookSubscriptionStatus = "active" | "unsupported" | "error";

type StoredRow = {
  id: string;
  business_id: string;
  /** The calendly_connections row this subscription belongs to. */
  connection_id: string;
  status: CalendlyWebhookSubscriptionStatus;
  subscription_uri: string | null;
  signing_key_encrypted: string | null;
  /** Calendly user URI the active subscription observes. */
  user_uri: string | null;
  /** `<providerConfigKey>:<connectionId>` that produced this row. */
  connection_key: string | null;
  last_attempt_at: string;
};

/** Decrypted row, server-side use only. */
export type CalendlyWebhookSubscriptionRow = Omit<StoredRow, "signing_key_encrypted"> & {
  /** Cleartext signing key; null unless the subscription is active. */
  signingKey: string | null;
};

const ALL_COLUMNS =
  "id,business_id,connection_id,status,subscription_uri,signing_key_encrypted,user_uri," +
  "connection_key,last_attempt_at";

function toDecryptedRow(row: StoredRow): CalendlyWebhookSubscriptionRow {
  const { signing_key_encrypted: encrypted, ...rest } = row;
  return { ...rest, signingKey: decryptIntegrationSecret(encrypted) };
}

/** One connection's subscription row (decrypted), or null. */
export async function getCalendlyWebhookSubscription(
  businessId: string,
  connectionId: string,
  client?: SupabaseClient
): Promise<CalendlyWebhookSubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_webhook_subscriptions")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`getCalendlyWebhookSubscription: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredRow);
}

/**
 * Every subscription row for the business (decrypted), oldest first. The
 * webhook receiver tries each row's signing key against a delivery, the
 * URL only carries the business id, so WHICH account delivered is proven
 * by whichever key verifies.
 */
export async function listCalendlyWebhookSubscriptions(
  businessId: string,
  client?: SupabaseClient
): Promise<CalendlyWebhookSubscriptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_webhook_subscriptions")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .order("last_attempt_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`listCalendlyWebhookSubscriptions: ${error.message}`);
  return ((data ?? []) as unknown as StoredRow[]).map(toDecryptedRow);
}

export type UpsertCalendlyWebhookSubscriptionInput = {
  businessId: string;
  /** The calendly_connections row this subscription belongs to. */
  connectionId: string;
  status: CalendlyWebhookSubscriptionStatus;
  /** Both required for 'active'; both cleared otherwise. */
  subscriptionUri?: string | null;
  signingKey?: string | null;
  /** Calendly user URI the subscription observes (active rows). */
  userUri?: string | null;
  /** `<providerConfigKey>:<connectionId>` behind this attempt. */
  connectionKey?: string | null;
};

/** Record an attempt outcome (stamps last_attempt_at = now). */
export async function upsertCalendlyWebhookSubscription(
  input: UpsertCalendlyWebhookSubscriptionInput,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const { error } = await db.from("calendly_webhook_subscriptions").upsert(
    {
      business_id: input.businessId,
      connection_id: input.connectionId,
      status: input.status,
      subscription_uri: input.subscriptionUri ?? null,
      signing_key_encrypted: encryptIntegrationSecret(input.signingKey ?? null),
      user_uri: input.userUri ?? null,
      connection_key: input.connectionKey ?? null,
      last_attempt_at: now,
      updated_at: now
    },
    { onConflict: "connection_id" }
  );
  if (error) throw new Error(`upsertCalendlyWebhookSubscription: ${error.message}`);
}

/** Drop one connection's row (teardown: connection removed/disabled). */
export async function deleteCalendlyWebhookSubscription(
  businessId: string,
  connectionId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("calendly_webhook_subscriptions")
    .delete()
    .eq("business_id", businessId)
    .eq("connection_id", connectionId);
  if (error) throw new Error(`deleteCalendlyWebhookSubscription: ${error.message}`);
}
