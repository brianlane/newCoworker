/**
 * Per-business direct Zoom connections (`zoom_connections`).
 *
 * The first-party OAuth path for Zoom (Nango-free primary; legacy Nango rows
 * in `workspace_oauth_connections` stay honored by the resolver). One row per
 * business holding the Zoom token pair, access token AND rotating refresh
 * token, both encrypted at rest via `@/lib/integrations/secrets` (same crypto
 * as calendly_connections / vagaro_connections), plus the connected
 * account's identity captured at connect time.
 *
 * Service-role only: RLS is on with no policies. Decrypted tokens never
 * leave a server-side function, the dashboard gets
 * `toPublicZoomConnection` (has_tokens flag, no ciphertext).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";
import type { ZoomClientEnv } from "@/lib/zoom/oauth";

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
  auto_import_transcripts: boolean;
  /** Which Marketplace client minted the pair; refresh/revoke must match it. */
  oauth_client_env: ZoomClientEnv;
  created_at: string;
  updated_at: string;
};

/** Decrypted row, server-side use only (direct API calls / refresh). */
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
  "is_active,auto_import_transcripts,oauth_client_env,created_at,updated_at";

function toDecryptedRow(row: StoredZoomConnectionRow): ZoomConnectionRow {
  const {
    access_token_encrypted: encAccess,
    refresh_token_encrypted: encRefresh,
    ...rest
  } = row;
  if (encAccess.length === 0 && encRefresh.length === 0) {
    // Deliberately wiped pair (Zoom-side deauthorization): the row survives
    // so the dashboard shows "Needs reconnect", but there is nothing to
    // decrypt and no bearer to present.
    return { ...rest, accessToken: "", refreshToken: "" };
  }
  const accessToken = decryptIntegrationSecret(encAccess);
  const refreshToken = decryptIntegrationSecret(encRefresh);
  if (accessToken === null || refreshToken === null) {
    // NOT NULL columns, so this only happens on an undecryptable stored
    // value, fail closed rather than calling Zoom with an empty bearer.
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

/** Active connection only, the meeting-tool gate. */
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

/** Dashboard listing shape (no decrypt, masked). Null when not connected. */
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
  /**
   * Which client minted this pair. Required, and written on BOTH branches
   * below: this is also the reconnect path, so leaving it out would strand a
   * tenant that moved back to production on dev credentials it no longer has.
   */
  clientEnv: ZoomClientEnv;
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
    is_active: true,
    oauth_client_env: input.clientEnv
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
 * refresh, so both tokens must land atomically in one UPDATE, a crash
 * between "used old refresh token" and "stored new one" would strand the
 * connection (the old token is single-use).
 *
 * `expectedUpdatedAt` is an optimistic-concurrency fence for cross-instance
 * races: the update only applies while the row still carries the timestamp
 * the caller read the (now consumed) refresh token from. Returns whether the
 * pair was stored, `false` means another writer got there first and the
 * caller should re-read instead of clobbering the newer rotation.
 */
export async function updateZoomTokens(
  businessId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
  expectedUpdatedAt?: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_connections")
    .update({
      access_token_encrypted: encryptIntegrationSecret(tokens.accessToken),
      refresh_token_encrypted: encryptIntegrationSecret(tokens.refreshToken),
      token_expires_at: tokens.expiresAt.toISOString(),
      updated_at: new Date().toISOString()
    })
    .match({
      business_id: businessId,
      ...(expectedUpdatedAt === undefined ? {} : { updated_at: expectedUpdatedAt })
    })
    .select("id");
  if (error) throw new Error(`updateZoomTokens: ${error.message}`);
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
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

/** What the webhook dispatcher needs to route an event, no token material. */
export type ZoomConnectionSummary = {
  business_id: string;
  auto_import_transcripts: boolean;
};

/**
 * Resolve the tenant(s) behind a webhook event's host/user id. One Zoom
 * account can be connected to multiple businesses (an owner with two
 * tenants), so this returns every ACTIVE match; a deauthorized or
 * soft-disabled connection routes nothing.
 *
 * Deliberately NOT scoped by oauth_client_env: recording payloads carry no
 * client id and the app-level Secret Token cannot attribute a delivery to a
 * client, so transcript routing matches connections under either client and
 * relies on the per-business import ledger to absorb double deliveries.
 */
export async function getActiveZoomConnectionSummariesByZoomUserId(
  zoomUserId: string,
  client?: SupabaseClient
): Promise<ZoomConnectionSummary[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("zoom_connections")
    .select("business_id,auto_import_transcripts")
    .eq("zoom_user_id", zoomUserId)
    .eq("is_active", true);
  if (error) {
    throw new Error(`getActiveZoomConnectionSummariesByZoomUserId: ${error.message}`);
  }
  return (data ?? []) as ZoomConnectionSummary[];
}

/**
 * Every business holding a connection for this Zoom user under this client,
 * ACTIVE OR NOT. The app_deauthorized wipe must reach rows that were already
 * soft-disabled (e.g. after an invalid_grant refresh), or their dead
 * ciphertext would survive the Zoom-side uninstall.
 *
 * The client-env filter is load-bearing, not tidiness: without it a
 * deauthorization of the DEVELOPMENT client would wipe the token pair of a
 * production tenant whose owner happens to use the same Zoom account, taking
 * their meeting scheduling down until someone noticed and reconnected. The
 * env comes from the deauthorization payload's client_id (the app-level
 * Secret Token cannot attribute a delivery); `null` means the payload's
 * client id was missing or unrecognized, and falls back to wiping across
 * both clients, the pre-dual-client behavior.
 */
export async function getZoomConnectionBusinessIdsByZoomUserId(
  zoomUserId: string,
  clientEnv: ZoomClientEnv | null,
  client?: SupabaseClient
): Promise<string[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("zoom_connections")
    .select("business_id")
    .eq("zoom_user_id", zoomUserId);
  const { data, error } = await (clientEnv === null
    ? base
    : base.eq("oauth_client_env", clientEnv));
  if (error) {
    throw new Error(`getZoomConnectionBusinessIdsByZoomUserId: ${error.message}`);
  }
  return ((data ?? []) as Array<{ business_id: string }>).map((row) => row.business_id);
}

/**
 * Backfill the connected account's identity onto a row whose connect-time
 * users/me fetch failed (zoom_user_id null): without it, webhook host
 * routing can never match this tenant. Email/name are fill-only extras.
 * The update is CONDITIONAL on zoom_user_id still being null, so a slow
 * backfill can never overwrite the fresh identity written by a concurrent
 * OAuth reconnect.
 */
export async function updateZoomConnectionIdentity(
  businessId: string,
  identity: { zoomUserId: string; email: string | null; displayName: string | null },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_connections")
    .update({
      zoom_user_id: identity.zoomUserId,
      ...(identity.email === null ? {} : { account_email: identity.email }),
      ...(identity.displayName === null ? {} : { account_name: identity.displayName }),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .is("zoom_user_id", null);
  if (error) throw new Error(`updateZoomConnectionIdentity: ${error.message}`);
}

/** Owner toggle for the recording.transcript_completed auto-import path. */
export async function setZoomConnectionAutoImport(
  businessId: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_connections")
    .update({ auto_import_transcripts: enabled, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`setZoomConnectionAutoImport: ${error.message}`);
}

/**
 * Zoom-side uninstall (app_deauthorized webhook): the token pair is dead at
 * Zoom the moment the user deauthorizes, so wipe it and flip the row
 * inactive in one update. The row survives so the dashboard card shows
 * "Needs reconnect" rather than pretending the business never connected.
 */
export async function markZoomConnectionDeauthorized(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("zoom_connections")
    .update({
      is_active: false,
      access_token_encrypted: "",
      refresh_token_encrypted: "",
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  if (error) throw new Error(`markZoomConnectionDeauthorized: ${error.message}`);
}
