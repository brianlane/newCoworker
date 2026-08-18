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
  /**
   * App-scoped id (ASID) of the Facebook user who authorized this. The only
   * handle Meta's deauthorize / data-deletion callbacks carry, so it is what
   * they join on. Null on connections made before we captured it, and on any
   * the backfill could not reach.
   */
  meta_user_id: string | null;
  /**
   * When Meta first answered code 190 for this connection. Null while the
   * token is believed good. NOT the same as is_active, which is the owner's
   * own pause switch: this one means the credential died.
   */
  token_invalid_at: string | null;
  /** IG professional account linked to the Page (null when none). */
  instagram_account_id: string | null;
  instagram_username: string | null;
  /** Conversions API dataset (pixel) id — null until discoverable. */
  dataset_id: string | null;
  /** Per-tenant kill switch for the Conversion Leads feedback loop. */
  capi_enabled: boolean;
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
  /**
   * Meta is refusing this connection's token and the owner must reconnect.
   * Derived so the card never has to know about the column, and kept
   * separate from is_active, which is the owner's own pause switch.
   */
  needs_reconnect: boolean;
};

const ALL_COLUMNS =
  "id,business_id,status,user_token_encrypted,page_id,page_name," +
  "page_token_encrypted,account_name,meta_user_id,token_invalid_at," +
  "instagram_account_id,instagram_username," +
  "dataset_id,capi_enabled,is_active,created_at,updated_at";

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
  return {
    ...rest,
    has_page_token: (page_token_encrypted ?? "").length > 0,
    needs_reconnect: Boolean(row.token_invalid_at)
  };
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
 * Webhook routing for `object: "instagram"` entries: the ACTIVE connection
 * whose linked IG professional account matches, with the page token
 * decrypted (IG DMs send through the same page-token edge). Enforced
 * unique by `uq_meta_connections_instagram`.
 */
export async function getActiveMetaConnectionByInstagramId(
  instagramAccountId: string,
  client?: SupabaseClient
): Promise<MetaConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .select(ALL_COLUMNS)
    .eq("instagram_account_id", instagramAccountId)
    .eq("status", "active")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveMetaConnectionByInstagramId: ${error.message}`);
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
 * `pending` with a fresh long-lived user token. Reconnecting restarts the
 * picker (tokens cleared, status pending), but the previously connected
 * Page's identity + discovered dataset are KEPT as last-known values: if
 * the owner re-picks the same Page and dataset discovery hiccups, the
 * activation reuses the stored dataset instead of silently losing the
 * Conversion Leads feedback loop. Picking a different Page overwrites all
 * of it.
 */
export async function savePendingMetaConnection(
  input: {
    businessId: string;
    userToken: string;
    accountName: string | null;
    /** ASID from /me; see meta_user_id on the row type. */
    metaUserId?: string | null;
  },
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
    // page_id / page_name / dataset_id deliberately NOT cleared (see above);
    // the page token always is — a pending row must never be able to send.
    page_token_encrypted: null,
    account_name: input.accountName,
    // A fresh OAuth grant is exactly the fix for a dead token, so clear the
    // flag here rather than making the owner wait for the next success.
    token_invalid_at: null,
    // Only ever overwrite with a real value: a reconnect whose /me lookup
    // failed must not erase the id the callbacks depend on.
    ...(input.metaUserId ? { meta_user_id: input.metaUserId } : {}),
    instagram_account_id: null,
    instagram_username: null,
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
    /** Linked IG professional account, when the Page has one. */
    instagramAccountId?: string | null;
    instagramUsername?: string | null;
    /** Conversions API dataset id, when discoverable (post-App-Review). */
    datasetId?: string | null;
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
      instagram_account_id: input.instagramAccountId ?? null,
      instagram_username: input.instagramUsername ?? null,
      dataset_id: input.datasetId ?? null,
      token_invalid_at: null,
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

/**
 * Set (or clear) the tenant's Conversions API dataset id — the owner-entered
 * value from /dashboard/integrations/meta. Meta's platform flow has the
 * ADVERTISER create the CRM dataset in Events Manager and hand it over;
 * nothing derives it, so this is a plain edit and an owner may correct a
 * typo by saving again. Scoped to an ACTIVE connection: a pending row has
 * no Page yet, so it has nothing to attach a dataset to.
 *
 * Returns the updated public row, or null when no ACTIVE row matched
 * (disconnected or still pending between the read and the write) — callers
 * surface that instead of reporting a save that never landed.
 */
export async function setMetaConnectionDataset(
  businessId: string,
  datasetId: string | null,
  client?: SupabaseClient
): Promise<PublicMetaConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .update({ dataset_id: datasetId, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("status", "active")
    .select(ALL_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`setMetaConnectionDataset: ${error.message}`);
  return data ? toPublicMetaConnection(data as unknown as StoredMetaConnectionRow) : null;
}

/**
 * Every connection a given Facebook user authorized. Plural on purpose: one
 * person can connect several businesses, and a deauthorization or deletion
 * request from them must reach all of them, not the first one found.
 */
export async function listMetaConnectionsByMetaUserId(
  metaUserId: string,
  client?: SupabaseClient
): Promise<PublicMetaConnectionRow[]> {
  const id = metaUserId.trim();
  // An empty id would match every row whose column is null. Refuse rather
  // than sever the whole fleet.
  if (!id) return [];
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .select(ALL_COLUMNS)
    .eq("meta_user_id", id)
    .limit(200);
  if (error) throw new Error(`listMetaConnectionsByMetaUserId: ${error.message}`);
  return ((data ?? []) as unknown as StoredMetaConnectionRow[]).map(toPublicMetaConnection);
}

/**
 * Delete one connection outright: both tokens, the account name, and every
 * Page and Instagram identifier Facebook gave us go with the row.
 *
 * DELETED, not blanked. A blanked row keeps `status: "pending"`, and the
 * integrations card reads any pending row as an in-progress Page pick: it
 * would show "Almost there", try to list Pages with no user token, and land
 * the owner on "No Pages found" (Bugbot, PR #1443). Removing the row shows
 * the honest "not connected" state instead, and it is what actually
 * happened: the person revoked the app.
 *
 * Nothing is lost by deleting. The audit trail lives outside this table, in
 * meta_data_deletion_requests (which records the app-scoped id and how many
 * connections were cleared) and in a per-business system log line. For a
 * data-deletion request in particular, keeping a row that still identifies
 * the requester would be the wrong instinct.
 *
 * SCOPE, deliberately narrow: this erases what FACEBOOK gave us about the
 * person who authorized the app. It does NOT touch the tenant's contacts,
 * leads, or conversations: those are the business's own records about its own
 * customers, kept on a different legal basis, and wiping a company's CRM
 * because an administrator removed a Facebook app would be both wrong and
 * unrecoverable.
 */
export async function deleteMetaConnectionById(
  connectionId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .delete()
    .eq("id", connectionId)
    // A delete matching zero rows returns no error in PostgREST, so select
    // and check rather than assume it landed.
    .select("id");
  if (error) throw new Error(`deleteMetaConnectionById: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Record the ASID on a connection that predates us capturing it. */
export async function setMetaConnectionUserId(
  connectionId: string,
  metaUserId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const id = metaUserId.trim();
  if (!id) return false;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("meta_connections")
    .update({ meta_user_id: id, updated_at: new Date().toISOString() })
    .eq("id", connectionId)
    .select("id");
  if (error) throw new Error(`setMetaConnectionUserId: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Flag or clear a connection's dead-token state.
 *
 * Idempotent on the way IN: the first 190 stamps the time and later ones
 * leave it, so `token_invalid_at` answers "since when", which is what the
 * owner alert's once-a-day guard and the card's copy both want. Returns
 * whether this call was the one that flipped it, so only the first failure
 * escalates to the owner.
 */
export async function setMetaTokenInvalid(
  businessId: string,
  invalid: boolean,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const query = db
    .from("meta_connections")
    .update({
      token_invalid_at: invalid ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  // Only stamp a connection that is not already flagged, so a fleet of
  // failing calls cannot keep moving the timestamp forward and re-arming the
  // alert. Clearing is unconditional.
  const { data, error } = await (invalid ? query.is("token_invalid_at", null) : query).select("id");
  if (error) throw new Error(`setMetaTokenInvalid: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
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
