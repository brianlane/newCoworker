/**
 * Per-business Cal.com OAuth connections (`cal_connections`).
 *
 * Service-role only. Decrypted tokens never leave a server function. The
 * dashboard gets `toPublicCalConnection` (no ciphertext).
 */
import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";
import { clearedReauthFields, withReauthColumnDefaults } from "@/lib/connections/reauth-copy";
import type { CalTokenSet } from "@/lib/cal/oauth";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type StoredCalConnectionRow = {
  id: string;
  business_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: string;
  cal_user_id: string | null;
  account_email: string | null;
  account_name: string | null;
  username: string | null;
  time_zone: string | null;
  default_event_type_id: string | null;
  webhook_id: string | null;
  webhook_secret_encrypted: string | null;
  webhook_verification_token: string;
  is_active: boolean;
  needs_reauth: boolean;
  last_healthy_at: string | null;
  reauth_email_count: number;
  reauth_email_last_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CalConnectionRow = Omit<
  StoredCalConnectionRow,
  "access_token_encrypted" | "refresh_token_encrypted" | "webhook_secret_encrypted"
> & {
  accessToken: string;
  refreshToken: string;
  webhookSecret: string | null;
};

export type PublicCalConnectionRow = Omit<
  StoredCalConnectionRow,
  "access_token_encrypted" | "refresh_token_encrypted" | "webhook_secret_encrypted"
> & { has_tokens: boolean };

const ALL_COLUMNS =
  "id,business_id,access_token_encrypted,refresh_token_encrypted,token_expires_at," +
  "cal_user_id,account_email,account_name,username,time_zone,default_event_type_id," +
  "webhook_id,webhook_secret_encrypted,webhook_verification_token,is_active,needs_reauth," +
  "last_healthy_at,reauth_email_count,reauth_email_last_sent_at,created_at,updated_at";

export function newCalWebhookToken(): string {
  return randomBytes(24).toString("hex");
}

function toDecryptedRow(row: StoredCalConnectionRow): CalConnectionRow {
  const {
    access_token_encrypted: encAccess,
    refresh_token_encrypted: encRefresh,
    webhook_secret_encrypted: encSecret,
    ...rest
  } = row;
  const accessToken = decryptIntegrationSecret(encAccess);
  const refreshToken = decryptIntegrationSecret(encRefresh);
  if (accessToken === null || refreshToken === null) {
    throw new Error("cal connection has no stored token pair");
  }
  const webhookSecret = encSecret ? decryptIntegrationSecret(encSecret) : null;
  return { ...rest, accessToken, refreshToken, webhookSecret };
}

export function toPublicCalConnection(row: StoredCalConnectionRow): PublicCalConnectionRow {
  const { access_token_encrypted, refresh_token_encrypted, webhook_secret_encrypted, ...rest } =
    withReauthColumnDefaults(row as unknown as Record<string, unknown>) as unknown as StoredCalConnectionRow;
  return {
    ...rest,
    has_tokens: access_token_encrypted.length > 0 && refresh_token_encrypted.length > 0
  };
}

export async function upsertCalConnection(
  args: {
    businessId: string;
    tokens: CalTokenSet;
    profile: {
      id: string | null;
      email: string | null;
      name: string | null;
      username: string | null;
      timeZone: string | null;
    };
    defaultEventTypeId: string | null;
    webhookToken: string;
  },
  client?: SupabaseClient
): Promise<CalConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("cal_connections")
    .upsert(
      {
        business_id: args.businessId,
        access_token_encrypted: encryptIntegrationSecret(args.tokens.accessToken),
        refresh_token_encrypted: encryptIntegrationSecret(args.tokens.refreshToken),
        token_expires_at: args.tokens.expiresAt.toISOString(),
        cal_user_id: args.profile.id,
        account_email: args.profile.email,
        account_name: args.profile.name,
        username: args.profile.username,
        time_zone: args.profile.timeZone,
        default_event_type_id: args.defaultEventTypeId,
        webhook_verification_token: args.webhookToken,
        is_active: true,
        updated_at: now,
        ...clearedReauthFields(now)
      },
      { onConflict: "business_id" }
    )
    .select(ALL_COLUMNS)
    .single();
  if (error || !data) throw new Error(`upsertCalConnection: ${error?.message ?? "no row"}`);
  return toDecryptedRow(data as unknown as StoredCalConnectionRow);
}

export async function getCalConnectionById(
  id: string,
  client?: SupabaseClient
): Promise<CalConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.from("cal_connections").select(ALL_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`getCalConnectionById: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredCalConnectionRow);
}

export async function getCalConnectionByBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<CalConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("cal_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getCalConnectionByBusiness: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredCalConnectionRow);
}

export async function getActiveCalConnectionId(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("cal_connections")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveCalConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

export async function getPublicCalConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicCalConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("cal_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicCalConnection: ${error.message}`);
  if (!data) return null;
  return toPublicCalConnection(data as unknown as StoredCalConnectionRow);
}

export async function updateCalTokens(
  id: string,
  tokens: CalTokenSet,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("cal_connections")
    .update({
      access_token_encrypted: encryptIntegrationSecret(tokens.accessToken),
      refresh_token_encrypted: encryptIntegrationSecret(tokens.refreshToken),
      token_expires_at: tokens.expiresAt.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw new Error(`updateCalTokens: ${error.message}`);
}

export async function markCalHealthy(id: string, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("cal_connections")
    .update({ last_healthy_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`markCalHealthy: ${error.message}`);
}

export async function setCalWebhook(
  id: string,
  webhookId: string,
  secret: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("cal_connections")
    .update({
      webhook_id: webhookId,
      webhook_secret_encrypted: encryptIntegrationSecret(secret),
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw new Error(`setCalWebhook: ${error.message}`);
}

export async function setCalDefaultEventType(
  id: string,
  eventTypeId: string | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("cal_connections")
    .update({ default_event_type_id: eventTypeId, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`setCalDefaultEventType: ${error.message}`);
}

export async function deactivateCalConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("cal_connections")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`deactivateCalConnection: ${error.message}`);
}
