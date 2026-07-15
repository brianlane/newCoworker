/**
 * Per-business direct Meta (Facebook) Lead Ads connections
 * (`meta_connections`).
 *
 * Lifecycle: the OAuth callback stores a `pending` row holding the
 * long-lived USER token (encrypted); the owner then picks a Page on the
 * dashboard card, which stores the permanent PAGE token, subscribes the
 * Page to `leadgen`, flips the row to `active`, and clears the user token.
 * The webhook route resolves inbound leadgen events to a tenant via
 * `getActiveMetaConnectionByPageId`.
 *
 * Service-role only: RLS is on with no policies. Decrypted tokens never
 * leave server-side functions — the dashboard gets
 * `toPublicMetaConnection` (has_* flags, no ciphertext).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type MetaConnectionStatus = "pending" | "active";

type StoredMetaConnectionRow = {
  id: string;
  business_id: string;
  status: MetaConnectionStatus;
  user_token_encrypted: string | null;
  page_id: string | null;
  page_name: string | null;
  page_token_encrypted: string | null;
  account_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row — server-side use only (Graph API calls). */
export type MetaConnectionRow = Omit<
  StoredMetaConnectionRow,
  "user_token_encrypted" | "page_token_encrypted"
> & {
  userToken: string | null;
  pageToken: string | null;
};

/** Dashboard-facing shape: no token material at all. */
export type PublicMetaConnectionRow = Omit<
  StoredMetaConnectionRow,
  "user_token_encrypted" | "page_token_encrypted"
> & {
  has_page_token: boolean;
};

const ALL_COLUMNS =
  "id,business_id,status,user_token_encrypted,page_id,page_name," +
  "page_token_encrypted,account_name,is_active,created_at,updated_at";

function toDecryptedRow(row: StoredMetaConnectionRow): MetaConnectionRow {
  const {
    user_token_encrypted: userEncrypted,
    page_token_encrypted: pageEncrypted,
    ...rest
  } = row;
  return {
    ...rest,
    userToken: decryptIntegrationSecret(userEncrypted),
    pageToken: decryptIntegrationSecret(pageEncrypted)
  };
}

export function toPublicMetaConnection(
  row: StoredMetaConnectionRow
): PublicMetaConnectionRow {
  const { user_token_encrypted, page_token_encrypted, ...rest } = row;
  void user_token_encrypted;
  return { ...rest, has_page_token: (page_token_encrypted ?? "").length > 0 };
}

/** The business's connection with tokens decrypted, or null. */
export async function getMetaConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<MetaConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getMetaConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredMetaConnectionRow);
}

/** Dashboard listing shape (no decrypt — masked). Null when not connected. */
export async function getPublicMetaConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicMetaConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicMetaConnection: ${error.message}`);
  if (!data) return null;
  return toPublicMetaConnection(data as unknown as StoredMetaConnectionRow);
}

/**
 * Webhook routing: the ACTIVE connection holding this Page, with the page
 * token decrypted. Enforced unique by `uq_meta_connections_page`.
 */
export async function getActiveMetaConnectionByPageId(
  pageId: string,
  client?: SupabaseClient
): Promise<MetaConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .select(ALL_COLUMNS)
    .eq("page_id", pageId)
    .eq("status", "active")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveMetaConnectionByPageId: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredMetaConnectionRow);
}

/**
 * Whoever holds this Page's unique claim (`uq_meta_connections_page`) —
 * ACTIVE or PAUSED. Distinct from getActiveMetaConnectionByPageId: paused
 * rows keep both the claim and the Meta subscription, so unsubscribe
 * decisions must consult THIS, never the active-only lookup.
 */
export async function getMetaPageClaim(
  pageId: string,
  client?: SupabaseClient
): Promise<{ business_id: string } | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .select("business_id")
    .eq("page_id", pageId)
    .maybeSingle();
  if (error) throw new Error(`getMetaPageClaim: ${error.message}`);
  return (data as { business_id: string } | null) ?? null;
}

export class MetaConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaConnectionValidationError";
  }
}

/**
 * OAuth callback landing: create (or reset) the business's connection as
 * `pending` with a fresh long-lived user token. Any previously connected
 * Page is cleared — reconnecting restarts the picker.
 */
export async function savePendingMetaConnection(
  input: { businessId: string; userToken: string; accountName: string | null },
  client?: SupabaseClient
): Promise<PublicMetaConnectionRow> {
  const token = input.userToken.trim();
  if (token.length === 0 || token.length > 4096) {
    throw new MetaConnectionValidationError("User token must be 1-4096 characters");
  }

  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("meta_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`savePendingMetaConnection: ${readError.message}`);

  const fields = {
    status: "pending" as const,
    user_token_encrypted: encryptIntegrationSecret(token),
    page_id: null,
    page_name: null,
    page_token_encrypted: null,
    account_name: input.accountName,
    is_active: true
  };

  if (!existing) {
    const { data, error } = await db
      .from("meta_connections")
      .insert({ business_id: input.businessId, ...fields })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`savePendingMetaConnection: ${error.message}`);
    return toPublicMetaConnection(data as unknown as StoredMetaConnectionRow);
  }

  const { data, error } = await db
    .from("meta_connections")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`savePendingMetaConnection: ${error.message}`);
  return toPublicMetaConnection(data as unknown as StoredMetaConnectionRow);
}

/**
 * Page picked + leadgen subscribed: store the permanent page token, flip to
 * `active`, and drop the user token (no longer needed; least privilege).
 *
 * Guarded on `status = 'pending'` so concurrent picks can't both win: the
 * second update matches zero rows and fails, and its caller rolls back its
 * own Meta subscription — no orphaned subscription without a routing row.
 */
export async function activateMetaConnection(
  input: {
    businessId: string;
    pageId: string;
    pageName: string | null;
    pageToken: string;
  },
  client?: SupabaseClient
): Promise<PublicMetaConnectionRow> {
  const token = input.pageToken.trim();
  if (token.length === 0 || token.length > 4096) {
    throw new MetaConnectionValidationError("Page token must be 1-4096 characters");
  }

  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .update({
      status: "active",
      user_token_encrypted: null,
      page_id: input.pageId,
      page_name: input.pageName,
      page_token_encrypted: encryptIntegrationSecret(token),
      is_active: true,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", input.businessId)
    .eq("status", "pending")
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`activateMetaConnection: ${error.message}`);
  return toPublicMetaConnection(data as unknown as StoredMetaConnectionRow);
}

/** Soft-disable / re-enable (webhook deliveries refuse while inactive). */
export async function setMetaConnectionActive(
  businessId: string,
  isActive: boolean,
  client?: SupabaseClient
): Promise<PublicMetaConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`setMetaConnectionActive: ${error.message}`);
  return toPublicMetaConnection(data as unknown as StoredMetaConnectionRow);
}

export async function deleteMetaConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("meta_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteMetaConnection: ${error.message}`);
}
