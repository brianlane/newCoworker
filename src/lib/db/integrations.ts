import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type IntegrationProvider =
  | "google"
  | "outlook"
  | "slack"
  | "zoom"
  | "hubspot"
  | "salesforce"
  | "custom_crm"
  | "twilio"
  | "custom_tool";

export type IntegrationAuthType = "oauth" | "api_key";

export type IntegrationStatus = "connected" | "disconnected" | "expired" | "error";

export type IntegrationRow = {
  id: string;
  business_id: string;
  provider: string;
  auth_type: IntegrationAuthType;
  status: IntegrationStatus;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  api_key_encrypted: string | null;
  scopes: string[] | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type PublicIntegrationRow = Omit<
  IntegrationRow,
  "access_token" | "refresh_token" | "api_key_encrypted"
>;

export function toPublicIntegrationRow(row: IntegrationRow | PublicIntegrationRow): PublicIntegrationRow {
  const { access_token: _accessToken, refresh_token: _refreshToken, api_key_encrypted: _apiKey, ...rest } =
    row as IntegrationRow;
  return rest;
}

export async function getIntegrations(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicIntegrationRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("integrations")
    .select(
      "id,business_id,provider,auth_type,status,token_expires_at,scopes,metadata,created_at,updated_at"
    )
    .eq("business_id", businessId)
    .order("provider");

  if (error) throw new Error(`getIntegrations: ${error.message}`);
  return ((data ?? []) as PublicIntegrationRow[]).map(toPublicIntegrationRow);
}

export async function getIntegration(
  businessId: string,
  provider: string,
  client?: SupabaseClient
): Promise<IntegrationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("integrations")
    .select()
    .eq("business_id", businessId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw new Error(`getIntegration: ${error.message}`);
  return (data as IntegrationRow) ?? null;
}

export type UpsertIntegrationInput = {
  businessId: string;
  provider: string;
  authType: IntegrationAuthType;
  status: IntegrationStatus;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  apiKeyEncrypted?: string | null;
  scopes?: string[] | null;
  metadata?: Record<string, unknown>;
};

export async function upsertIntegration(
  input: UpsertIntegrationInput,
  client?: SupabaseClient
): Promise<IntegrationRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const row = {
    business_id: input.businessId,
    provider: input.provider,
    auth_type: input.authType,
    status: input.status,
    access_token: input.accessToken ?? null,
    refresh_token: input.refreshToken ?? null,
    token_expires_at: input.tokenExpiresAt ?? null,
    api_key_encrypted: input.apiKeyEncrypted ?? null,
    scopes: input.scopes ?? null,
    metadata: input.metadata ?? {},
    updated_at: now
  };

  const { data, error } = await db
    .from("integrations")
    .upsert(row, { onConflict: "business_id,provider" })
    .select()
    .single();

  if (error) throw new Error(`upsertIntegration: ${error.message}`);
  return data as IntegrationRow;
}

export async function deleteIntegration(
  businessId: string,
  provider: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("integrations")
    .delete()
    .eq("business_id", businessId)
    .eq("provider", provider);

  if (error) throw new Error(`deleteIntegration: ${error.message}`);
}
