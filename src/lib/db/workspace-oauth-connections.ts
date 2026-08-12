import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Which side holds the OAuth grant for a connection row.
 *
 * - `nango`: Nango holds the tokens; we store only a pointer
 *   (provider_config_key + connection_id) and proxy through them.
 * - `direct`: we hold the token pair ourselves, encrypted on this row.
 *
 * The provider_config_key is IDENTICAL across both (an Outlook mailbox is
 * `outlook` either way), so every resolver and every AiFlow mailbox binding
 * is transport-blind. Only the proxy dispatcher looks at this field.
 */
export type WorkspaceConnectionTransport = "nango" | "direct";

/**
 * A workspace connection WITHOUT token material.
 *
 * The token columns are deliberately absent from this type AND from
 * `CONNECTION_COLUMNS` below, so the general read path cannot carry
 * ciphertext even by accident. Everything that lists or resolves connections
 * (the dashboard card, the calendar/email resolvers, the cap, cleanup) uses
 * this shape. Only the refresh path reads tokens, through its own narrowly
 * scoped query.
 */
export type WorkspaceOAuthConnectionRow = {
  id: string;
  business_id: string;
  provider_config_key: string;
  connection_id: string;
  metadata: Record<string, unknown>;
  transport: WorkspaceConnectionTransport;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Explicit column list for every general-purpose read.
 *
 * Not a style preference: an unqualified `select()` would pull
 * access_token_encrypted / refresh_token_encrypted into every caller that
 * only wanted to list a tenant's mailboxes, including the one whose result is
 * serialized toward the dashboard. Naming the columns keeps ciphertext out of
 * that path structurally rather than by convention.
 */
const CONNECTION_COLUMNS =
  "id, business_id, provider_config_key, connection_id, metadata, transport, is_active, created_at, updated_at";

export async function listWorkspaceOAuthConnections(
  businessId: string,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .select(CONNECTION_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`listWorkspaceOAuthConnections: ${error.message}`);
  return (data ?? []) as WorkspaceOAuthConnectionRow[];
}

export async function getWorkspaceOAuthConnection(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .select(CONNECTION_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`getWorkspaceOAuthConnection: ${error.message}`);
  return data ? (data as WorkspaceOAuthConnectionRow) : null;
}

/** Verifies a Nango connection belongs to the business (for proxy / token helpers). */
export async function getWorkspaceOAuthConnectionByNangoIds(
  businessId: string,
  providerConfigKey: string,
  connectionId: string,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .select(CONNECTION_COLUMNS)
    .eq("business_id", businessId)
    .eq("provider_config_key", providerConfigKey)
    .eq("connection_id", connectionId)
    .maybeSingle();

  if (error) throw new Error(`getWorkspaceOAuthConnectionByNangoIds: ${error.message}`);
  return data ? (data as WorkspaceOAuthConnectionRow) : null;
}

export type UpsertWorkspaceOAuthConnectionInput = {
  businessId: string;
  providerConfigKey: string;
  connectionId: string;
  metadata?: Record<string, unknown>;
};

export async function upsertWorkspaceOAuthConnection(
  input: UpsertWorkspaceOAuthConnectionInput,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const row = {
    business_id: input.businessId,
    provider_config_key: input.providerConfigKey,
    connection_id: input.connectionId,
    metadata: input.metadata ?? {},
    updated_at: now
  };

  const { data, error } = await db
    .from("workspace_oauth_connections")
    .upsert(row, { onConflict: "business_id,provider_config_key,connection_id" })
    .select(CONNECTION_COLUMNS)
    .single();

  if (error) throw new Error(`upsertWorkspaceOAuthConnection: ${error.message}`);
  return data as WorkspaceOAuthConnectionRow;
}

/**
 * Re-point an existing connection row at a NEW Nango connection id
 * (reconnect continuity): the row id, which AiFlow mailbox bindings and
 * email triggers reference, stays stable while the underlying OAuth grant
 * is replaced. Metadata is written wholesale; callers merge app-owned keys
 * (e.g. the shared-calendar id) before calling.
 */
export async function updateWorkspaceOAuthConnectionLink(
  args: {
    businessId: string;
    id: string;
    connectionId: string;
    metadata: Record<string, unknown>;
  },
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .update({
      connection_id: args.connectionId,
      metadata: args.metadata,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", args.businessId)
    .eq("id", args.id)
    .select(CONNECTION_COLUMNS)
    .single();

  if (error) throw new Error(`updateWorkspaceOAuthConnectionLink: ${error.message}`);
  return data as WorkspaceOAuthConnectionRow;
}

export async function deleteWorkspaceOAuthConnection(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .delete()
    .eq("business_id", businessId)
    .eq("id", id)
    .select(CONNECTION_COLUMNS)
    .maybeSingle();

  if (error) throw new Error(`deleteWorkspaceOAuthConnection: ${error.message}`);
  return data ? (data as WorkspaceOAuthConnectionRow) : null;
}

/* ------------------------------------------------------------------------ *
 * Direct-transport rows: the token pair we hold ourselves.
 *
 * Everything below is the ONLY path that touches token ciphertext. The
 * general reads above deliberately cannot see those columns, so a caller that
 * just wants to list a tenant's mailboxes cannot accidentally carry secrets.
 * ------------------------------------------------------------------------ */

/** A connection's decrypted token pair. Server-only, never serialized out. */
export type WorkspaceConnectionSecrets = {
  id: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  isActive: boolean;
  /** Fence value for the optimistic-concurrency guard on token rotation. */
  updatedAt: string;
};

export type WorkspaceDirectTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
};

function directTokenColumns(tokens: WorkspaceDirectTokens) {
  return {
    access_token_encrypted: encryptIntegrationSecret(tokens.accessToken),
    refresh_token_encrypted: encryptIntegrationSecret(tokens.refreshToken),
    token_expires_at: tokens.expiresAt.toISOString(),
    oauth_scope: tokens.scope
  };
}

/**
 * The token pair for one direct row, decrypted.
 *
 * Returns null when the row is missing, is a Nango row (no tokens by
 * definition), or carries an incomplete pair. A wiped pair is NOT a usable
 * connection even if the row was later force-reactivated: never send an empty
 * bearer.
 */
export async function getWorkspaceConnectionSecrets(
  id: string,
  client?: SupabaseClient
): Promise<WorkspaceConnectionSecrets | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .select(
      "id, transport, is_active, access_token_encrypted, refresh_token_encrypted, token_expires_at, updated_at"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`getWorkspaceConnectionSecrets: ${error.message}`);
  if (!data) return null;
  const row = data as {
    id: string;
    transport: string;
    is_active: boolean;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
    token_expires_at: string | null;
    updated_at: string;
  };
  if (row.transport !== "direct") return null;

  const accessToken = decryptIntegrationSecret(row.access_token_encrypted);
  const refreshToken = decryptIntegrationSecret(row.refresh_token_encrypted);
  if (!accessToken || !refreshToken || !row.token_expires_at) return null;

  return {
    id: row.id,
    accessToken,
    refreshToken,
    tokenExpiresAt: row.token_expires_at,
    isActive: row.is_active,
    updatedAt: row.updated_at
  };
}

/**
 * Persist a rotated token pair.
 *
 * `expectedUpdatedAt` is an optimistic-concurrency fence for cross-instance
 * races: the update only applies while the row still carries the timestamp the
 * caller read the (now consumed) refresh token from. Returns whether the pair
 * was stored; `false` means another writer got there first and the caller
 * should re-read rather than clobber the newer rotation.
 */
export async function updateWorkspaceConnectionTokens(
  id: string,
  tokens: WorkspaceDirectTokens,
  expectedUpdatedAt?: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .update({ ...directTokenColumns(tokens), updated_at: new Date().toISOString() })
    .match({
      id,
      ...(expectedUpdatedAt === undefined ? {} : { updated_at: expectedUpdatedAt })
    })
    .select("id");

  if (error) throw new Error(`updateWorkspaceConnectionTokens: ${error.message}`);
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}

/**
 * Persist a refreshed ACCESS token only, for providers that do not rotate.
 *
 * Google returns no `refresh_token` on a refresh: the stored one keeps working,
 * and two concurrent refreshes simply yield two independently valid access
 * tokens. So `updateWorkspaceConnectionTokens` is the wrong shape there twice
 * over. It would rewrite `refresh_token_encrypted` (there is nothing new to
 * write), and it would rewrite `oauth_scope` from a response that often omits
 * it, blanking the record of what the owner actually granted.
 *
 * `scope` is therefore written only when the provider reports one, so a refresh
 * can narrow the record when an owner revokes a box but never erase it.
 *
 * No optimistic-concurrency fence, deliberately: with nothing rotating there is
 * no lost-update hazard worth guarding, and last-write-wins is correct. The
 * direct-tokens check constraint still holds because the refresh token column is
 * left untouched.
 */
export async function updateWorkspaceConnectionAccessToken(
  id: string,
  args: { accessToken: string; expiresAt: Date; scope?: string | null },
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const scope = typeof args.scope === "string" && args.scope.length > 0 ? args.scope : undefined;
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .update({
      access_token_encrypted: encryptIntegrationSecret(args.accessToken),
      token_expires_at: args.expiresAt.toISOString(),
      ...(scope === undefined ? {} : { oauth_scope: scope }),
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("id");

  if (error) throw new Error(`updateWorkspaceConnectionAccessToken: ${error.message}`);
  return ((data as { id: string }[] | null)?.length ?? 0) > 0;
}

/** Soft-disable / re-enable (set false when a refresh returns invalid_grant). */
export async function setWorkspaceConnectionActive(
  id: string,
  isActive: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("workspace_oauth_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(`setWorkspaceConnectionActive: ${error.message}`);
}

export type UpsertDirectWorkspaceConnectionInput = {
  businessId: string;
  providerConfigKey: string;
  connectionId: string;
  metadata: Record<string, unknown>;
  tokens: WorkspaceDirectTokens;
};

/** Insert a brand-new direct connection (a mailbox this business had not linked). */
export async function insertDirectWorkspaceConnection(
  input: UpsertDirectWorkspaceConnectionInput,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .insert({
      business_id: input.businessId,
      provider_config_key: input.providerConfigKey,
      connection_id: input.connectionId,
      metadata: input.metadata,
      transport: "direct",
      is_active: true,
      ...directTokenColumns(input.tokens),
      updated_at: new Date().toISOString()
    })
    .select(CONNECTION_COLUMNS)
    .single();

  if (error) throw new Error(`insertDirectWorkspaceConnection: ${error.message}`);
  return data as WorkspaceOAuthConnectionRow;
}

/**
 * Re-point an EXISTING row at a fresh first-party grant, keeping its id.
 *
 * This is the whole reconnect story, and it works across transports: a row
 * that is still on Nango flips to `direct` in place. The id is what AiFlow
 * mailbox bindings and email triggers reference, so keeping it means a
 * reconnect never breaks a flow, and every reconnect quietly migrates one more
 * tenant off Nango.
 *
 * Metadata is written wholesale; callers merge app-owned keys (the
 * shared-calendar id and its ACL) before calling.
 */
export async function flipWorkspaceConnectionToDirect(
  args: {
    id: string;
    businessId: string;
    connectionId: string;
    metadata: Record<string, unknown>;
    tokens: WorkspaceDirectTokens;
  },
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .update({
      connection_id: args.connectionId,
      metadata: args.metadata,
      transport: "direct",
      is_active: true,
      ...directTokenColumns(args.tokens),
      updated_at: new Date().toISOString()
    })
    .eq("business_id", args.businessId)
    .eq("id", args.id)
    .select(CONNECTION_COLUMNS)
    .single();

  if (error) throw new Error(`flipWorkspaceConnectionToDirect: ${error.message}`);
  return data as WorkspaceOAuthConnectionRow;
}
