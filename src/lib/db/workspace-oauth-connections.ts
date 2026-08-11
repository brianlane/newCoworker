import { createSupabaseServiceClient } from "@/lib/supabase/server";

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
 * (reconnect continuity): the row id — which AiFlow mailbox bindings and
 * email triggers reference — stays stable while the underlying OAuth grant
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
