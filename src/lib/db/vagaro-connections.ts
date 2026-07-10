/**
 * Per-business Vagaro API connections (`vagaro_connections`).
 *
 * One row per business: the merchant's Client ID / Secret (secret encrypted
 * at rest via `@/lib/integrations/secrets`, same crypto as
 * custom_integrations), the regional API base URL, the tenant's webhook
 * verification token, and the booking defaults the calendar tools use.
 *
 * Service-role only: RLS is on with no policies, so every access goes
 * through these helpers after the caller's own auth checks. The decrypted
 * secret never leaves a server-side function — the dashboard gets
 * `toPublicVagaroConnection` (has_secret flag, no ciphertext).
 */
import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const VAGARO_DEFAULT_API_BASE_URL = "https://api.vagaro.com";

type StoredVagaroConnectionRow = {
  id: string;
  business_id: string;
  client_id: string;
  client_secret_encrypted: string;
  api_base_url: string;
  webhook_verification_token: string;
  default_service_id: string | null;
  default_employee_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row — server-side use only (token exchange, API calls). */
export type VagaroConnectionRow = Omit<
  StoredVagaroConnectionRow,
  "client_secret_encrypted"
> & {
  clientSecret: string;
};

/**
 * Dashboard-facing shape: no secret material at all. The webhook token IS
 * included — the owner must paste the webhook URL (which embeds it) into
 * Vagaro's settings, so the card needs it; it only authenticates inbound
 * event deliveries, never API access.
 */
export type PublicVagaroConnectionRow = Omit<
  StoredVagaroConnectionRow,
  "client_secret_encrypted"
> & {
  has_secret: boolean;
};

const ALL_COLUMNS =
  "id,business_id,client_id,client_secret_encrypted,api_base_url," +
  "webhook_verification_token,default_service_id,default_employee_id," +
  "is_active,created_at,updated_at";

function toDecryptedRow(row: StoredVagaroConnectionRow): VagaroConnectionRow {
  const { client_secret_encrypted: encrypted, ...rest } = row;
  const secret = decryptIntegrationSecret(encrypted);
  if (secret === null) {
    // NOT NULL column, so this only happens on a truly empty stored value —
    // fail closed rather than exchanging an empty secret.
    throw new Error("vagaro connection has no stored client secret");
  }
  return { ...rest, clientSecret: secret };
}

export function toPublicVagaroConnection(
  row: StoredVagaroConnectionRow
): PublicVagaroConnectionRow {
  const { client_secret_encrypted, ...rest } = row;
  return { ...rest, has_secret: client_secret_encrypted.length > 0 };
}

/** The business's connection with the secret decrypted, or null. */
export async function getVagaroConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<VagaroConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vagaro_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getVagaroConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredVagaroConnectionRow);
}

/** Active connection only — the calendar-tool and webhook gate. */
export async function getActiveVagaroConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<VagaroConnectionRow | null> {
  const row = await getVagaroConnection(businessId, client);
  return row && row.is_active ? row : null;
}

/**
 * Lightweight "is Vagaro connected?" probe for the calendar-provider
 * resolver: id-only select, no secret decryption on the hot path.
 */
export async function getActiveVagaroConnectionId(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vagaro_connections")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveVagaroConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Dashboard listing shape (no decrypt — masked). Null when not connected. */
export async function getPublicVagaroConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicVagaroConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("vagaro_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicVagaroConnection: ${error.message}`);
  if (!data) return null;
  return toPublicVagaroConnection(data as unknown as StoredVagaroConnectionRow);
}

export class VagaroConnectionValidationError extends Error {
  constructor(
    public readonly validationCode:
      | "client_id_invalid"
      | "client_secret_required"
      | "api_base_url_invalid",
    message: string
  ) {
    super(message);
    this.name = "VagaroConnectionValidationError";
  }
}

/** Mirrors the DB CHECK: https, host[:port], NO path/query/fragment. */
export function validateVagaroApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(trimmed)) {
    throw new VagaroConnectionValidationError(
      "api_base_url_invalid",
      "API base URL must be a bare https origin (e.g. https://api.vagaro.com)"
    );
  }
  return trimmed;
}

export type UpsertVagaroConnectionInput = {
  businessId: string;
  clientId: string;
  /**
   * Cleartext client secret. Required on create; `undefined` on update
   * keeps the stored secret.
   */
  clientSecret?: string;
  /**
   * Regional API host. Defaults to the US host on create; `undefined` on
   * update keeps the stored value (same semantics as `clientSecret` — a
   * credentials-only save must never reset a merchant's regional URL).
   */
  apiBaseUrl?: string;
  isActive?: boolean;
};

/**
 * Create or update the business's single connection. Creates mint a fresh
 * webhook verification token; updates never rotate it (the owner already
 * pasted the URL into Vagaro).
 */
export async function upsertVagaroConnection(
  input: UpsertVagaroConnectionInput,
  client?: SupabaseClient
): Promise<PublicVagaroConnectionRow> {
  const clientId = input.clientId.trim();
  if (clientId.length === 0 || clientId.length > 200) {
    throw new VagaroConnectionValidationError(
      "client_id_invalid",
      "Client ID must be 1-200 characters"
    );
  }
  const apiBaseUrl =
    input.apiBaseUrl === undefined ? null : validateVagaroApiBaseUrl(input.apiBaseUrl);
  const secret = input.clientSecret?.trim();

  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("vagaro_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`upsertVagaroConnection: ${readError.message}`);

  if (!existing) {
    if (!secret) {
      throw new VagaroConnectionValidationError(
        "client_secret_required",
        "Client Secret is required to connect Vagaro"
      );
    }
    const { data, error } = await db
      .from("vagaro_connections")
      .insert({
        business_id: input.businessId,
        client_id: clientId,
        client_secret_encrypted: encryptIntegrationSecret(secret),
        api_base_url: apiBaseUrl ?? VAGARO_DEFAULT_API_BASE_URL,
        webhook_verification_token: randomBytes(24).toString("hex"),
        ...(input.isActive === undefined ? {} : { is_active: input.isActive })
      })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`upsertVagaroConnection: ${error.message}`);
    return toPublicVagaroConnection(data as unknown as StoredVagaroConnectionRow);
  }

  const patch: Record<string, unknown> = {
    client_id: clientId,
    updated_at: new Date().toISOString(),
    ...(apiBaseUrl === null ? {} : { api_base_url: apiBaseUrl }),
    ...(secret ? { client_secret_encrypted: encryptIntegrationSecret(secret) } : {}),
    ...(input.isActive === undefined ? {} : { is_active: input.isActive })
  };
  const { data, error } = await db
    .from("vagaro_connections")
    .update(patch)
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`upsertVagaroConnection: ${error.message}`);
  return toPublicVagaroConnection(data as unknown as StoredVagaroConnectionRow);
}

/** Booking defaults chosen on the dashboard card (null clears a default). */
export async function setVagaroBookingDefaults(
  businessId: string,
  defaults: { defaultServiceId?: string | null; defaultEmployeeId?: string | null },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...("defaultServiceId" in defaults
      ? { default_service_id: defaults.defaultServiceId ?? null }
      : {}),
    ...("defaultEmployeeId" in defaults
      ? { default_employee_id: defaults.defaultEmployeeId ?? null }
      : {})
  };
  const { error } = await db
    .from("vagaro_connections")
    .update(patch)
    .eq("business_id", businessId);
  if (error) throw new Error(`setVagaroBookingDefaults: ${error.message}`);
}

export async function deleteVagaroConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("vagaro_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteVagaroConnection: ${error.message}`);
}
