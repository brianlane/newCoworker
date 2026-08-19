/**
 * Per-business direct Calendly connections (`calendly_connections`).
 *
 * The zero-setup alternative to the Nango OAuth path: rows hold a Calendly
 * Personal Access Token (encrypted at rest via `@/lib/integrations/secrets`,
 * same crypto as vagaro_connections) plus the connected account's identity
 * captured at verify time.
 *
 * Since 20260822132059 a business can hold SEVERAL connections, one per
 * Calendly ACCOUNT (unique on business_id + user_uri): a tenant whose
 * teammates book on their own Calendly accounts connects each PAT and the
 * booking machinery (poll triggers, booking precheck, goals, no-show)
 * unions events across all of them. The OLDEST active row is the PRIMARY
 * connection: single-calendar surfaces (find-slots, the voice tools'
 * "calendly connected" probe) keep their original behavior by reading it.
 *
 * Service-role only: RLS is on with no policies. The decrypted token never
 * leaves a server-side function, the dashboard gets
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
  /**
   * Cached canonical Calendly user URI for the stored PAT (GET /users/me),
   * constant per token, so the calendar-trigger poller reads it instead of
   * probing /users/me every tick. Null until first resolve; cleared when the
   * token changes (a new PAT can belong to a different account).
   */
  user_uri: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row, server-side use only (direct API calls). */
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
  "user_uri,is_active,created_at,updated_at";

function toDecryptedRow(row: StoredCalendlyConnectionRow): CalendlyConnectionRow {
  const { access_token_encrypted: encrypted, ...rest } = row;
  const token = decryptIntegrationSecret(encrypted);
  if (token === null) {
    // NOT NULL column, so this only happens on a truly empty stored value,
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

/**
 * Every connection for the business, tokens decrypted, oldest first (the
 * primary connection is index 0). Server-side use only.
 */
export async function listCalendlyConnections(
  businessId: string,
  client?: SupabaseClient
): Promise<CalendlyConnectionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`listCalendlyConnections: ${error.message}`);
  return ((data ?? []) as unknown as StoredCalendlyConnectionRow[]).map(toDecryptedRow);
}

/** Active connections only, oldest first, the multi-account read set. */
export async function listActiveCalendlyConnections(
  businessId: string,
  client?: SupabaseClient
): Promise<CalendlyConnectionRow[]> {
  const rows = await listCalendlyConnections(businessId, client);
  return rows.filter((r) => r.is_active);
}

/** One connection by id, token decrypted; null when absent/other business. */
export async function getCalendlyConnectionById(
  businessId: string,
  connectionId: string,
  client?: SupabaseClient
): Promise<CalendlyConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`getCalendlyConnectionById: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredCalendlyConnectionRow);
}

/**
 * The PRIMARY (oldest active) connection with the token decrypted, or null.
 * Single-calendar surfaces (find-slots, "is Calendly connected") read this;
 * booking DETECTION surfaces must use {@link listActiveCalendlyConnections}
 * so every connected account's events are seen.
 */
export async function getActiveCalendlyConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<CalendlyConnectionRow | null> {
  const rows = await listActiveCalendlyConnections(businessId, client);
  return rows[0] ?? null;
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
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getActiveCalendlyConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Cached user URI of ONE connection row (no token decryption). Null when
 * the row is absent, inactive, or not yet resolved.
 */
export async function getCalendlyConnectionUserUriById(
  connectionId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select("user_uri")
    .eq("id", connectionId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getCalendlyConnectionUserUriById: ${error.message}`);
  return (data as { user_uri: string | null } | null)?.user_uri ?? null;
}

/** Persist a freshly resolved user URI onto ONE connection row. */
export async function setCalendlyConnectionUserUri(
  connectionId: string,
  userUri: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("calendly_connections")
    .update({ user_uri: userUri, updated_at: new Date().toISOString() })
    .eq("id", connectionId);
  if (error) throw new Error(`setCalendlyConnectionUserUri: ${error.message}`);
}

/** Dashboard listing (no decrypt, masked), oldest first. */
export async function listPublicCalendlyConnections(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicCalendlyConnectionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`listPublicCalendlyConnections: ${error.message}`);
  return ((data ?? []) as unknown as StoredCalendlyConnectionRow[]).map(
    toPublicCalendlyConnection
  );
}

export class CalendlyConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendlyConnectionValidationError";
  }
}

export type SaveCalendlyConnectionInput = {
  businessId: string;
  /** Cleartext Personal Access Token (already verified by the caller). */
  accessToken: string;
  /**
   * VERIFIED account identity from GET /users/me. The route verifies BEFORE
   * saving, so a row is never created for a token that does not work, and
   * the user URI (the account's stable id) is present from birth, it is
   * the dedupe key that converges a re-pasted token for an already-linked
   * account onto its existing row instead of stacking a duplicate.
   */
  userUri: string;
  accountName: string | null;
  accountEmail: string | null;
};

/**
 * Create a connection for a not-yet-linked Calendly account, or converge
 * onto the existing row when `userUri` is already linked (token + identity
 * refresh, row re-activated). Returns the saved row (masked) and whether it
 * was newly created.
 */
export async function saveCalendlyConnection(
  input: SaveCalendlyConnectionInput,
  client?: SupabaseClient
): Promise<{ connection: PublicCalendlyConnectionRow; created: boolean }> {
  const token = input.accessToken.trim();
  if (token.length === 0 || token.length > 4096) {
    throw new CalendlyConnectionValidationError(
      "Personal Access Token must be 1-4096 characters"
    );
  }
  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("calendly_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .eq("user_uri", input.userUri)
    .maybeSingle();
  if (readError) throw new Error(`saveCalendlyConnection: ${readError.message}`);

  const identity = {
    account_name: input.accountName,
    account_email: input.accountEmail,
    user_uri: input.userUri
  };
  if (existing) {
    const { data, error } = await db
      .from("calendly_connections")
      .update({
        access_token_encrypted: encryptIntegrationSecret(token),
        ...identity,
        is_active: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", (existing as { id: string }).id)
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`saveCalendlyConnection: ${error.message}`);
    return {
      connection: toPublicCalendlyConnection(data as unknown as StoredCalendlyConnectionRow),
      created: false
    };
  }

  const { data, error } = await db
    .from("calendly_connections")
    .insert({
      business_id: input.businessId,
      access_token_encrypted: encryptIntegrationSecret(token),
      ...identity
    })
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`saveCalendlyConnection: ${error.message}`);
  return {
    connection: toPublicCalendlyConnection(data as unknown as StoredCalendlyConnectionRow),
    created: true
  };
}

/** Soft-enable/disable one connection. Returns the row, null when absent. */
export async function setCalendlyConnectionActive(
  businessId: string,
  connectionId: string,
  isActive: boolean,
  client?: SupabaseClient
): Promise<PublicCalendlyConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", connectionId)
    .select(ALL_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`setCalendlyConnectionActive: ${error.message}`);
  if (!data) return null;
  return toPublicCalendlyConnection(data as unknown as StoredCalendlyConnectionRow);
}

/** Hard-delete one connection. */
export async function deleteCalendlyConnection(
  businessId: string,
  connectionId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("calendly_connections")
    .delete()
    .eq("business_id", businessId)
    .eq("id", connectionId);
  if (error) throw new Error(`deleteCalendlyConnection: ${error.message}`);
}
