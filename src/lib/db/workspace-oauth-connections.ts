import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WorkspaceOAuthConnectionRow = {
  id: string;
  business_id: string;
  provider_config_key: string;
  connection_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function listWorkspaceOAuthConnections(
  businessId: string,
  client?: SupabaseClient
): Promise<WorkspaceOAuthConnectionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("workspace_oauth_connections")
    .select()
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
    .select()
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
    .select()
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
    .select()
    .single();

  if (error) throw new Error(`upsertWorkspaceOAuthConnection: ${error.message}`);
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
    .select()
    .maybeSingle();

  if (error) throw new Error(`deleteWorkspaceOAuthConnection: ${error.message}`);
  return data ? (data as WorkspaceOAuthConnectionRow) : null;
}
