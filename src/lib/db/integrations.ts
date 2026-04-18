import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type IntegrationProvider =
  | "outlook"
  | "slack"
  | "zoom"
  | "hubspot"
  | "salesforce"
  | "custom_crm"
  | "telnyx"
  | "custom_tool";

export type IntegrationAuthType = "oauth" | "api_key";

export type IntegrationStatus = "connected" | "disconnected" | "expired" | "error";

export const INTEGRATION_PROVIDERS = [
  "outlook",
  "slack",
  "zoom",
  "hubspot",
  "salesforce",
  "custom_crm",
  "telnyx",
  "custom_tool"
] as const satisfies readonly IntegrationProvider[];

type StoredIntegrationRow = {
  id: string;
  business_id: string;
  provider: IntegrationProvider;
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

export type IntegrationRow = Omit<StoredIntegrationRow, "api_key_encrypted"> & {
  api_key: string | null;
};

export type PublicIntegrationRow = Omit<
  IntegrationRow,
  "access_token" | "refresh_token" | "api_key"
>;

export function toPublicIntegrationRow(row: IntegrationRow | PublicIntegrationRow): PublicIntegrationRow {
  const { access_token: _accessToken, refresh_token: _refreshToken, api_key: _apiKey, ...rest } =
    row as IntegrationRow;
  return rest;
}

function toDecryptedIntegrationRow(row: StoredIntegrationRow): IntegrationRow {
  const { api_key_encrypted: encryptedApiKey, ...rest } = row;
  return {
    ...rest,
    access_token: decryptIntegrationSecret(row.access_token),
    refresh_token: decryptIntegrationSecret(row.refresh_token),
    api_key: decryptIntegrationSecret(encryptedApiKey)
  };
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
  provider: IntegrationProvider,
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
  if (!data) return null;
  return toDecryptedIntegrationRow(data as StoredIntegrationRow);
}

export type UpsertIntegrationInput = {
  businessId: string;
  provider: IntegrationProvider;
  authType: IntegrationAuthType;
  status: IntegrationStatus;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  apiKey?: string | null;
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
    access_token: encryptIntegrationSecret(input.accessToken ?? null),
    refresh_token: encryptIntegrationSecret(input.refreshToken ?? null),
    token_expires_at: input.tokenExpiresAt ?? null,
    api_key_encrypted: encryptIntegrationSecret(input.apiKey ?? null),
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
  return toDecryptedIntegrationRow(data as StoredIntegrationRow);
}

export async function deleteIntegration(
  businessId: string,
  provider: IntegrationProvider,
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
