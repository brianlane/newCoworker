/**
 * Per-business direct Zoom connections (`zoom_connections`).
 *
 * The first-party OAuth path for Zoom (Nango-free primary; legacy Nango rows
 * in `workspace_oauth_connections` stay honored by the resolver). One row per
 * business holding the Zoom token pair — access token AND rotating refresh
 * token, both encrypted at rest via `@/lib/integrations/secrets` (same crypto
 * as calendly_connections / vagaro_connections) — plus the connected
 * account's identity captured at connect time.
 *
 * Service-role only: RLS is on with no policies. Decrypted tokens never
 * leave a server-side function — the dashboard gets
 * `toPublicZoomConnection` (has_tokens flag, no ciphertext).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type StoredZoomConnectionRow = {
  id: string;
  business_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: string;
  zoom_user_id: string | null;
  account_email: string | null;
  account_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row — server-side use only (direct API calls / refresh). */
export type ZoomConnectionRow = Omit<
  StoredZoomConnectionRow,
  "access_token_encrypted" | "refresh_token_encrypted"
> & {
  accessToken: string;
  refreshToken: string;
};

/** Dashboard-facing shape: no token material at all. */
export type PublicZoomConnectionRow = Omit<
  StoredZoomConnectionRow,
  "access_token_encrypted" | "refresh_token_encrypted"
> & {
  has_tokens: boolean;
};

const ALL_COLUMNS =
  "id,business_id,access_token_encrypted,refresh_token_encrypted," +
  "token_expires_at,zoom_user_id,account_email,account_name," +
  "is_active,created_at,updated_at";

function toDecryptedRow(row: StoredZoomConnectionRow): ZoomConnectionRow {
  const {
    access_token_encrypted: encAccess,
    refresh_token_encrypted: encRefresh,
    ...rest
  } = row;
  const accessToken = decryptIntegrationSecret(encAccess);
  const refreshToken = decryptIntegrationSecret(encRefresh);
  if (accessToken === null || refreshToken === null) {
    // NOT NULL columns, so this only happens on a truly empty stored value —
    // fail closed rather than calling Zoom with an empty bearer.
    throw new Error("zoom connection has no stored token pair");
  }
  return { ...rest, accessToken, refreshToken };
}

export function toPublicZoomConnection(
  row: StoredZoomConnectionRow
): PublicZoomConnectionRow {
  const { access_token_encrypted, refresh_token_encrypted, ...rest } = row;
  return {
    ...rest,
    has_tokens:
      access_token_encrypted.length > 0 && refresh_token_encrypted.length > 0
  };
}

/** The business's connection with tokens decrypted, or null. */
export async function getZoomConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<ZoomConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getZoomConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredZoomConnectionRow);
}

/** Active connection only — the meeting-tool gate. */
export async function getActiveZoomConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<ZoomConnectionRow | null> {
  const row = await getZoomConnection(businessId, client);
  return row && row.is_active ? row : null;
}

/**
 * Lightweight "is a direct Zoom connected?" probe for the resolver:
 * id-only select, no token decryption.
 */
export async function getActiveZoomConnectionId(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_connections")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveZoomConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Dashboard listing shape (no decrypt — masked). Null when not connected. */
export async function getPublicZoomConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicZoomConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicZoomConnection: ${error.message}`);
  if (!data) return null;
  return toPublicZoomConnection(data as unknown as StoredZoomConnectionRow);
}

export type UpsertZoomConnectionInput = {
  businessId: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute access-token expiry. */
  expiresAt: Date;
  zoomUserId?: string | null;
  accountEmail?: string | null;
  accountName?: string | null;
};

/**
 * Create or replace the business's single direct connection (connect /
 * reconnect flow). A reconnect always re-activates the row.
 */
export async function upsertZoomConnection(
  input: UpsertZoomConnectionInput,
  client?: SupabaseClient
): Promise<PublicZoomConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const values = {
    access_token_encrypted: encryptIntegrationSecret(input.accessToken),
    refresh_token_encrypted: encryptIntegrationSecret(input.refreshToken),
    token_expires_at: input.expiresAt.toISOString(),
    zoom_user_id: input.zoomUserId ?? null,
    account_email: input.accountEmail ?? null,
    account_name: input.accountName ?? null,
    is_active: true
  };

  const { data: existing, error: readError } = await db
    .from("zoom_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`upsertZoomConnection: ${readError.message}`);

  if (!existing) {
    const { data, error } = await db
      .from("zoom_connections")
      .insert({ business_id: input.businessId, ...values })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`upsertZoomConnection: ${error.message}`);
    return toPublicZoomConnection(data as unknown as StoredZoomConnectionRow);
  }

  const { data, error } = await db
    .from("zoom_connections")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`upsertZoomConnection: ${error.message}`);
  return toPublicZoomConnection(data as unknown as StoredZoomConnectionRow);
}

/**
 * Persist a refreshed token pair. Zoom ROTATES the refresh token on every
 * refresh, so both tokens must land atomically in one UPDATE — a crash
 * between "used old refresh token" and "stored new one" would strand the
 * connection (the old token is single-use).
 */
export async function updateZoomTokens(
  businessId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_connections")
    .update({
      access_token_encrypted: encryptIntegrationSecret(tokens.accessToken),
      refresh_token_encrypted: encryptIntegrationSecret(tokens.refreshToken),
      token_expires_at: tokens.expiresAt.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  if (error) throw new Error(`updateZoomTokens: ${error.message}`);
}

/** Soft-disable / re-enable (also used when a refresh returns invalid_grant). */
export async function setZoomConnectionActive(
  businessId: string,
  isActive: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`setZoomConnectionActive: ${error.message}`);
}

export async function deleteZoomConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteZoomConnection: ${error.message}`);
}
