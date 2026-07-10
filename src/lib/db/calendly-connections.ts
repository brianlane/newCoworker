/**
 * Per-business direct Calendly connections (`calendly_connections`).
 *
 * The zero-setup alternative to the Nango OAuth path: one row per business
 * holding a Calendly Personal Access Token (encrypted at rest via
 * `@/lib/integrations/secrets`, same crypto as vagaro_connections) plus the
 * connected account's identity captured at verify time.
 *
 * Service-role only: RLS is on with no policies. The decrypted token never
 * leaves a server-side function — the dashboard gets
 * `toPublicCalendlyConnection` (has_token flag, no ciphertext).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type StoredCalendlyConnectionRow = {
  id: string;
  business_id: string;
  access_token_encrypted: string;
  account_name: string | null;
  account_email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row — server-side use only (direct API calls). */
export type CalendlyConnectionRow = Omit<
  StoredCalendlyConnectionRow,
  "access_token_encrypted"
> & {
  accessToken: string;
};

/** Dashboard-facing shape: no token material at all. */
export type PublicCalendlyConnectionRow = Omit<
  StoredCalendlyConnectionRow,
  "access_token_encrypted"
> & {
  has_token: boolean;
};

const ALL_COLUMNS =
  "id,business_id,access_token_encrypted,account_name,account_email," +
  "is_active,created_at,updated_at";

function toDecryptedRow(row: StoredCalendlyConnectionRow): CalendlyConnectionRow {
  const { access_token_encrypted: encrypted, ...rest } = row;
  const token = decryptIntegrationSecret(encrypted);
  if (token === null) {
    // NOT NULL column, so this only happens on a truly empty stored value —
    // fail closed rather than calling Calendly with an empty bearer.
    throw new Error("calendly connection has no stored access token");
  }
  return { ...rest, accessToken: token };
}

export function toPublicCalendlyConnection(
  row: StoredCalendlyConnectionRow
): PublicCalendlyConnectionRow {
  const { access_token_encrypted, ...rest } = row;
  return { ...rest, has_token: access_token_encrypted.length > 0 };
}

/** The business's connection with the token decrypted, or null. */
export async function getCalendlyConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<CalendlyConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getCalendlyConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredCalendlyConnectionRow);
}

/** Active connection only — the calendar-tool gate. */
export async function getActiveCalendlyConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<CalendlyConnectionRow | null> {
  const row = await getCalendlyConnection(businessId, client);
  return row && row.is_active ? row : null;
}

/**
 * Lightweight "is a direct Calendly connected?" probe for the
 * calendar-provider resolver: id-only select, no token decryption.
 */
export async function getActiveCalendlyConnectionId(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveCalendlyConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Dashboard listing shape (no decrypt — masked). Null when not connected. */
export async function getPublicCalendlyConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicCalendlyConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicCalendlyConnection: ${error.message}`);
  if (!data) return null;
  return toPublicCalendlyConnection(data as unknown as StoredCalendlyConnectionRow);
}

export type UpsertCalendlyConnectionInput = {
  businessId: string;
  /**
   * Cleartext Personal Access Token. Required on create; `undefined` on
   * update keeps the stored token.
   */
  accessToken?: string;
  /** Verified account identity (from GET /users/me); null clears it. */
  accountName?: string | null;
  accountEmail?: string | null;
  isActive?: boolean;
};

export class CalendlyConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendlyConnectionValidationError";
  }
}

/** Create or update the business's single direct connection. */
export async function upsertCalendlyConnection(
  input: UpsertCalendlyConnectionInput,
  client?: SupabaseClient
): Promise<PublicCalendlyConnectionRow> {
  const token = input.accessToken?.trim();
  if (token !== undefined && (token.length === 0 || token.length > 4096)) {
    throw new CalendlyConnectionValidationError(
      "Personal Access Token must be 1-4096 characters"
    );
  }

  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("calendly_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`upsertCalendlyConnection: ${readError.message}`);

  if (!existing) {
    if (!token) {
      throw new CalendlyConnectionValidationError(
        "A Personal Access Token is required to connect Calendly"
      );
    }
    const { data, error } = await db
      .from("calendly_connections")
      .insert({
        business_id: input.businessId,
        access_token_encrypted: encryptIntegrationSecret(token),
        ...("accountName" in input ? { account_name: input.accountName ?? null } : {}),
        ...("accountEmail" in input ? { account_email: input.accountEmail ?? null } : {}),
        ...(input.isActive === undefined ? {} : { is_active: input.isActive })
      })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`upsertCalendlyConnection: ${error.message}`);
    return toPublicCalendlyConnection(data as unknown as StoredCalendlyConnectionRow);
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...(token ? { access_token_encrypted: encryptIntegrationSecret(token) } : {}),
    ...("accountName" in input ? { account_name: input.accountName ?? null } : {}),
    ...("accountEmail" in input ? { account_email: input.accountEmail ?? null } : {}),
    ...(input.isActive === undefined ? {} : { is_active: input.isActive })
  };
  const { data, error } = await db
    .from("calendly_connections")
    .update(patch)
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`upsertCalendlyConnection: ${error.message}`);
  return toPublicCalendlyConnection(data as unknown as StoredCalendlyConnectionRow);
}

export async function deleteCalendlyConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("calendly_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteCalendlyConnection: ${error.message}`);
}
