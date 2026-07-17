/**
 * Service-role data access for per-tenant WhatsApp Business connections
 * (whatsapp_connections — migration 20260811210000_whatsapp_channel.sql).
 *
 * The Embedded Signup business token is AES-256-GCM encrypted at rest via
 * src/lib/integrations/secrets.ts (calendly/meta pattern). RLS is on with
 * no policies, so ALL access flows through here after the caller's own
 * auth: the webhook route verifies the Meta signature first, internal
 * routes require the cron bearer, dashboard routes gate on
 * requireBusinessRole.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Per-template review status, keyed by template name. */
export type WhatsAppTemplatesState = Record<
  string,
  { status: string; language: string }
>;

type StoredWhatsAppConnectionRow = {
  id: string;
  business_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  access_token_encrypted: string;
  templates: WhatsAppTemplatesState | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row — server-side use only (Cloud API calls). */
export type WhatsAppConnectionRow = Omit<
  StoredWhatsAppConnectionRow,
  "access_token_encrypted"
> & {
  accessToken: string | null;
};

/** Dashboard-facing shape: no token material at all. */
export type PublicWhatsAppConnectionRow = Omit<
  StoredWhatsAppConnectionRow,
  "access_token_encrypted"
>;

const ALL_COLUMNS =
  "id,business_id,waba_id,phone_number_id,display_phone_number," +
  "access_token_encrypted,templates,is_active,created_at,updated_at";

function toDecryptedRow(row: StoredWhatsAppConnectionRow): WhatsAppConnectionRow {
  const { access_token_encrypted: encrypted, ...rest } = row;
  return { ...rest, accessToken: decryptIntegrationSecret(encrypted) };
}

export function toPublicWhatsAppConnection(
  row: StoredWhatsAppConnectionRow
): PublicWhatsAppConnectionRow {
  const { access_token_encrypted: _encrypted, ...rest } = row;
  void _encrypted;
  return rest;
}

export class WhatsAppConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppConnectionValidationError";
  }
}

export async function getWhatsAppConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<WhatsAppConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getWhatsAppConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredWhatsAppConnectionRow);
}

export async function getPublicWhatsAppConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicWhatsAppConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicWhatsAppConnection: ${error.message}`);
  if (!data) return null;
  return toPublicWhatsAppConnection(data as unknown as StoredWhatsAppConnectionRow);
}

/**
 * Webhook routing: the ACTIVE connection holding this phone number id,
 * token decrypted. Enforced unique by uq_whatsapp_connections_phone_number.
 */
export async function getActiveWhatsAppConnectionByPhoneNumberId(
  phoneNumberId: string,
  client?: SupabaseClient
): Promise<WhatsAppConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .select(ALL_COLUMNS)
    .eq("phone_number_id", phoneNumberId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    throw new Error(`getActiveWhatsAppConnectionByPhoneNumberId: ${error.message}`);
  }
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredWhatsAppConnectionRow);
}

/**
 * Whoever holds this phone number's unique claim (active or paused) —
 * pre-insert conflict messaging for the connect route.
 */
export async function getWhatsAppPhoneNumberClaim(
  phoneNumberId: string,
  client?: SupabaseClient
): Promise<{ business_id: string } | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .select("business_id")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  if (error) throw new Error(`getWhatsAppPhoneNumberClaim: ${error.message}`);
  return (data as { business_id: string } | null) ?? null;
}

/**
 * Whether any OTHER business also holds a connection on this WABA (a
 * multi-number WABA shared across tenants). Consulted before the
 * reconnect path unsubscribes an abandoned WABA — tearing down the app
 * subscription would silence every number under it.
 */
export async function isWabaClaimedByOtherBusiness(
  wabaId: string,
  excludingBusinessId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .select("business_id")
    .eq("waba_id", wabaId)
    .neq("business_id", excludingBusinessId)
    .limit(1);
  if (error) throw new Error(`isWabaClaimedByOtherBusiness: ${error.message}`);
  return ((data as unknown[]) ?? []).length > 0;
}

/**
 * Embedded Signup landing: create or replace the business's connection.
 * Reconnects overwrite in place (token, WABA, number all refresh).
 */
export async function saveWhatsAppConnection(
  input: {
    businessId: string;
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    accessToken: string;
    templates: WhatsAppTemplatesState;
  },
  client?: SupabaseClient
): Promise<PublicWhatsAppConnectionRow> {
  const token = input.accessToken.trim();
  if (token.length === 0 || token.length > 4096) {
    throw new WhatsAppConnectionValidationError("Access token must be 1-4096 characters");
  }
  if (!input.wabaId.trim() || !input.phoneNumberId.trim()) {
    throw new WhatsAppConnectionValidationError("WABA id and phone number id are required");
  }

  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .upsert(
      {
        business_id: input.businessId,
        waba_id: input.wabaId.trim(),
        phone_number_id: input.phoneNumberId.trim(),
        display_phone_number: input.displayPhoneNumber,
        access_token_encrypted: encryptIntegrationSecret(token),
        templates: input.templates,
        is_active: true,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id" }
    )
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`saveWhatsAppConnection: ${error.message}`);
  return toPublicWhatsAppConnection(data as unknown as StoredWhatsAppConnectionRow);
}

/** Merge fresher template review statuses onto the connection row. */
export async function updateWhatsAppTemplates(
  businessId: string,
  templates: WhatsAppTemplatesState,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("whatsapp_connections")
    .update({ templates, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`updateWhatsAppTemplates: ${error.message}`);
}

/** Soft-disable / re-enable (webhook routing and sends refuse while off). */
export async function setWhatsAppConnectionActive(
  businessId: string,
  isActive: boolean,
  client?: SupabaseClient
): Promise<PublicWhatsAppConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("whatsapp_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`setWhatsAppConnectionActive: ${error.message}`);
  return toPublicWhatsAppConnection(data as unknown as StoredWhatsAppConnectionRow);
}

export async function deleteWhatsAppConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("whatsapp_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteWhatsAppConnection: ${error.message}`);
}
