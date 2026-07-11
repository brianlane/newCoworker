/**
 * Per-business direct CalDAV connections (`caldav_connections`).
 *
 * The zero-OAuth calendar path for iCloud / Nextcloud / any CalDAV server:
 * one row per business holding the server URL, username, and an app-specific
 * password (encrypted at rest via `@/lib/integrations/secrets`, same crypto
 * as calendly_connections), plus the event calendar discovered at verify
 * time so tool calls skip the discovery walk.
 *
 * Service-role only: RLS is on with no policies. The decrypted password
 * never leaves a server-side function — the dashboard gets
 * `toPublicCaldavConnection` (has_password flag, no ciphertext).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";
import { isPrivateOrLoopbackHost } from "@/lib/db/custom-integrations";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type StoredCaldavConnectionRow = {
  id: string;
  business_id: string;
  server_url: string;
  username: string;
  password_encrypted: string;
  calendar_url: string | null;
  calendar_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** Decrypted row — server-side use only (direct CalDAV calls). */
export type CaldavConnectionRow = Omit<StoredCaldavConnectionRow, "password_encrypted"> & {
  password: string;
};

/** Dashboard-facing shape: no secret material at all. */
export type PublicCaldavConnectionRow = Omit<
  StoredCaldavConnectionRow,
  "password_encrypted"
> & {
  has_password: boolean;
};

const ALL_COLUMNS =
  "id,business_id,server_url,username,password_encrypted,calendar_url," +
  "calendar_name,is_active,created_at,updated_at";

export class CaldavConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaldavConnectionValidationError";
  }
}

/**
 * Validate + normalize a CalDAV server URL at storage time: https only,
 * public host, no embedded credentials. This is the registration-time
 * SSRF gate; the client re-validates every request URL (discovery hops can
 * land on other hosts, e.g. iCloud partition servers).
 */
export function normalizeCaldavServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CaldavConnectionValidationError("Server URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new CaldavConnectionValidationError("Server URL must use https://");
  }
  if (url.username || url.password) {
    throw new CaldavConnectionValidationError(
      "Put credentials in the username/password fields, not the URL"
    );
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new CaldavConnectionValidationError(
      "Server URL points at a private/loopback host"
    );
  }
  return url.toString();
}

function toDecryptedRow(row: StoredCaldavConnectionRow): CaldavConnectionRow {
  const { password_encrypted: encrypted, ...rest } = row;
  const password = decryptIntegrationSecret(encrypted);
  if (password === null) {
    // NOT NULL column, so this only happens on a truly empty stored value —
    // fail closed rather than calling the server with an empty password.
    throw new Error("caldav connection has no stored password");
  }
  return { ...rest, password };
}

export function toPublicCaldavConnection(
  row: StoredCaldavConnectionRow
): PublicCaldavConnectionRow {
  const { password_encrypted, ...rest } = row;
  return { ...rest, has_password: password_encrypted.length > 0 };
}

/** The business's connection with the password decrypted, or null. */
export async function getCaldavConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<CaldavConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("caldav_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getCaldavConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredCaldavConnectionRow);
}

/** Active connection only — the calendar-tool gate. */
export async function getActiveCaldavConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<CaldavConnectionRow | null> {
  const row = await getCaldavConnection(businessId, client);
  return row && row.is_active ? row : null;
}

/**
 * Lightweight "is a direct CalDAV connected?" probe for the
 * calendar-provider resolver: id-only select, no password decryption.
 */
export async function getActiveCaldavConnectionId(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("caldav_connections")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveCaldavConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Dashboard listing shape (no decrypt — masked). Null when not connected. */
export async function getPublicCaldavConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicCaldavConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("caldav_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicCaldavConnection: ${error.message}`);
  if (!data) return null;
  return toPublicCaldavConnection(data as unknown as StoredCaldavConnectionRow);
}

export type UpsertCaldavConnectionInput = {
  businessId: string;
  /** Required on create; `undefined` on update keeps the stored value. */
  serverUrl?: string;
  username?: string;
  /** Cleartext app-specific password; `undefined` on update keeps it. */
  password?: string;
  /** Discovered event calendar (verify flow); null clears it. */
  calendarUrl?: string | null;
  calendarName?: string | null;
  isActive?: boolean;
};

/** Create or update the business's single direct connection. */
export async function upsertCaldavConnection(
  input: UpsertCaldavConnectionInput,
  client?: SupabaseClient
): Promise<PublicCaldavConnectionRow> {
  const serverUrl =
    input.serverUrl === undefined ? undefined : normalizeCaldavServerUrl(input.serverUrl);
  const username = input.username?.trim();
  if (username !== undefined && (username.length === 0 || username.length > 512)) {
    throw new CaldavConnectionValidationError("Username must be 1-512 characters");
  }
  const password = input.password?.trim();
  if (password !== undefined && (password.length === 0 || password.length > 1024)) {
    throw new CaldavConnectionValidationError("Password must be 1-1024 characters");
  }

  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("caldav_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`upsertCaldavConnection: ${readError.message}`);

  if (!existing) {
    if (!serverUrl || !username || !password) {
      throw new CaldavConnectionValidationError(
        "Server URL, username, and an app-specific password are required to connect"
      );
    }
    const { data, error } = await db
      .from("caldav_connections")
      .insert({
        business_id: input.businessId,
        server_url: serverUrl,
        username,
        password_encrypted: encryptIntegrationSecret(password),
        ...("calendarUrl" in input ? { calendar_url: input.calendarUrl ?? null } : {}),
        ...("calendarName" in input ? { calendar_name: input.calendarName ?? null } : {}),
        ...(input.isActive === undefined ? {} : { is_active: input.isActive })
      })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`upsertCaldavConnection: ${error.message}`);
    return toPublicCaldavConnection(data as unknown as StoredCaldavConnectionRow);
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...(serverUrl === undefined ? {} : { server_url: serverUrl }),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined
      ? {}
      : { password_encrypted: encryptIntegrationSecret(password) }),
    ...("calendarUrl" in input ? { calendar_url: input.calendarUrl ?? null } : {}),
    ...("calendarName" in input ? { calendar_name: input.calendarName ?? null } : {}),
    ...(input.isActive === undefined ? {} : { is_active: input.isActive })
  };
  const { data, error } = await db
    .from("caldav_connections")
    .update(patch)
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`upsertCaldavConnection: ${error.message}`);
  return toPublicCaldavConnection(data as unknown as StoredCaldavConnectionRow);
}

export async function deleteCaldavConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("caldav_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteCaldavConnection: ${error.message}`);
}
