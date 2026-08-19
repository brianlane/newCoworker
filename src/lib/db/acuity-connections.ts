/**
 * Per-business Acuity Scheduling connections (`acuity_connections`).
 *
 * One row per business: the merchant's Acuity User ID + API Key (key
 * encrypted at rest via `@/lib/integrations/secrets`, same crypto as
 * vagaro_connections / custom_integrations), the API origin, the tenant's
 * webhook verification token, the booking defaults the calendar tools use,
 * and the dynamic-webhook registration state.
 *
 * Service-role only: RLS is on with no policies, so every access goes
 * through these helpers after the caller's own auth checks. The decrypted
 * key never leaves a server-side function, the dashboard gets
 * `toPublicAcuityConnection` (has_api_key flag, no ciphertext).
 *
 * Shape mirrors `@/lib/db/vagaro-connections` on purpose: the two providers
 * are the same kind of thing (a merchant's real book behind direct
 * credentials), and the calendar-tool layer treats them symmetrically.
 */
import { randomBytes } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const ACUITY_DEFAULT_API_BASE_URL = "https://acuityscheduling.com";

/**
 * How dynamic webhook registration ended. `unsupported` (Acuity refused the
 * Webhooks API for these credentials) and `cap_reached` (the account is at
 * its 25-webhook ceiling) are BOTH normal outcomes the card must explain,
 * not errors, inbound events still arrive if the owner pastes the URL by
 * hand, and the poller covers them regardless.
 */
export type AcuityWebhookRegistrationStatus =
  | "registered"
  | "unsupported"
  | "cap_reached";

export type AcuityWebhookRegistration = {
  /** Acuity's webhook ids we created, so teardown is exact. */
  ids: string[];
  /** The callback URL we registered; used to reconcile on re-connect. */
  targetUrl: string | null;
  /** ISO stamp of the last successful reconcile, for the 24h recheck. */
  registeredAt: string | null;
  status: AcuityWebhookRegistrationStatus;
};

type StoredAcuityConnectionRow = {
  id: string;
  business_id: string;
  user_id: string;
  api_key_encrypted: string;
  api_base_url: string;
  webhook_verification_token: string;
  default_appointment_type_id: string | null;
  default_calendar_id: string | null;
  default_calendar_timezone: string | null;
  suppress_provider_emails: boolean;
  webhook_registration: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Decrypted row, server-side use only. The API key doubles as the webhook
 * HMAC secret, so the webhook receiver needs this shape too (it cannot work
 * from the public one).
 */
export type AcuityConnectionRow = Omit<
  StoredAcuityConnectionRow,
  "api_key_encrypted"
> & {
  apiKey: string;
};

/**
 * Dashboard-facing shape: no secret material at all. The webhook token IS
 * included, when dynamic registration is unavailable the owner pastes the
 * webhook URL (which embeds it) into Acuity's settings, so the card needs
 * it; it only gates inbound deliveries, never API access.
 */
export type PublicAcuityConnectionRow = Omit<
  StoredAcuityConnectionRow,
  "api_key_encrypted"
> & {
  has_api_key: boolean;
};

const ALL_COLUMNS =
  "id,business_id,user_id,api_key_encrypted,api_base_url," +
  "webhook_verification_token,default_appointment_type_id,default_calendar_id," +
  "default_calendar_timezone,suppress_provider_emails,webhook_registration," +
  "is_active,created_at,updated_at";

/** Narrow the jsonb column to the typed registration record. */
export function readWebhookRegistration(
  raw: Record<string, unknown> | null | undefined
): AcuityWebhookRegistration {
  const ids = Array.isArray(raw?.ids)
    ? (raw.ids as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const status = raw?.status;
  return {
    ids,
    targetUrl: typeof raw?.targetUrl === "string" ? raw.targetUrl : null,
    registeredAt: typeof raw?.registeredAt === "string" ? raw.registeredAt : null,
    status:
      status === "unsupported" || status === "cap_reached" || status === "registered"
        ? status
        : "unsupported"
  };
}

function toDecryptedRow(row: StoredAcuityConnectionRow): AcuityConnectionRow {
  const { api_key_encrypted: encrypted, ...rest } = row;
  const apiKey = decryptIntegrationSecret(encrypted);
  if (apiKey === null) {
    // NOT NULL column, so this only happens on a truly empty stored value,
    // fail closed rather than authenticating with an empty key (which Acuity
    // would answer with a 401 we'd surface as "reconnect your account").
    throw new Error("acuity connection has no stored api key");
  }
  return { ...rest, apiKey };
}

export function toPublicAcuityConnection(
  row: StoredAcuityConnectionRow
): PublicAcuityConnectionRow {
  const { api_key_encrypted, ...rest } = row;
  return { ...rest, has_api_key: api_key_encrypted.length > 0 };
}

/** The business's connection with the API key decrypted, or null. */
export async function getAcuityConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<AcuityConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("acuity_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getAcuityConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredAcuityConnectionRow);
}

/** Active connection only, the calendar-tool and webhook gate. */
export async function getActiveAcuityConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<AcuityConnectionRow | null> {
  const row = await getAcuityConnection(businessId, client);
  return row && row.is_active ? row : null;
}

/**
 * Lightweight "is Acuity connected?" probe for the calendar-provider
 * resolver: id-only select, no key decryption on the hot path.
 */
export async function getActiveAcuityConnectionId(
  businessId: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("acuity_connections")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`getActiveAcuityConnectionId: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Dashboard listing shape (no decrypt, masked). Null when not connected. */
export async function getPublicAcuityConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicAcuityConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("acuity_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicAcuityConnection: ${error.message}`);
  if (!data) return null;
  return toPublicAcuityConnection(data as unknown as StoredAcuityConnectionRow);
}

export class AcuityConnectionValidationError extends Error {
  constructor(
    public readonly validationCode:
      | "user_id_invalid"
      | "api_key_required"
      | "api_base_url_invalid",
    message: string
  ) {
    super(message);
    this.name = "AcuityConnectionValidationError";
  }
}

/** Mirrors the DB CHECK: https, host[:port], NO path/query/fragment. */
export function validateAcuityApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(trimmed)) {
    throw new AcuityConnectionValidationError(
      "api_base_url_invalid",
      "API base URL must be a bare https origin (e.g. https://acuityscheduling.com)"
    );
  }
  return trimmed;
}

export type UpsertAcuityConnectionInput = {
  businessId: string;
  userId: string;
  /**
   * Cleartext API key. Required on create; `undefined` on update keeps the
   * stored key (so a "change my default appointment type" save never has to
   * re-ask for the credential).
   */
  apiKey?: string;
  /**
   * API origin. Defaults to the public host on create; `undefined` on update
   * keeps the stored value (same semantics as `apiKey`).
   */
  apiBaseUrl?: string;
  isActive?: boolean;
};

/**
 * Create or update the business's single connection. Creates mint a fresh
 * webhook verification token; updates never rotate it (the owner may have
 * already pasted the URL into Acuity, and rotating would silently break
 * every inbound delivery).
 */
export async function upsertAcuityConnection(
  input: UpsertAcuityConnectionInput,
  client?: SupabaseClient
): Promise<PublicAcuityConnectionRow> {
  const userId = input.userId.trim();
  if (userId.length === 0 || userId.length > 64) {
    throw new AcuityConnectionValidationError(
      "user_id_invalid",
      "Acuity User ID must be 1-64 characters"
    );
  }
  const apiBaseUrl =
    input.apiBaseUrl === undefined ? null : validateAcuityApiBaseUrl(input.apiBaseUrl);
  const apiKey = input.apiKey?.trim();

  const db = client ?? (await createSupabaseServiceClient());
  const { data: existing, error: readError } = await db
    .from("acuity_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`upsertAcuityConnection: ${readError.message}`);

  if (!existing) {
    if (!apiKey) {
      throw new AcuityConnectionValidationError(
        "api_key_required",
        "API Key is required to connect Acuity"
      );
    }
    const { data, error } = await db
      .from("acuity_connections")
      .insert({
        business_id: input.businessId,
        user_id: userId,
        api_key_encrypted: encryptIntegrationSecret(apiKey),
        api_base_url: apiBaseUrl ?? ACUITY_DEFAULT_API_BASE_URL,
        webhook_verification_token: randomBytes(24).toString("hex"),
        ...(input.isActive === undefined ? {} : { is_active: input.isActive })
      })
      .select(ALL_COLUMNS)
      .single();
    if (error) throw new Error(`upsertAcuityConnection: ${error.message}`);
    return toPublicAcuityConnection(data as unknown as StoredAcuityConnectionRow);
  }

  const patch: Record<string, unknown> = {
    user_id: userId,
    updated_at: new Date().toISOString(),
    ...(apiBaseUrl === null ? {} : { api_base_url: apiBaseUrl }),
    ...(apiKey ? { api_key_encrypted: encryptIntegrationSecret(apiKey) } : {}),
    ...(input.isActive === undefined ? {} : { is_active: input.isActive })
  };
  const { data, error } = await db
    .from("acuity_connections")
    .update(patch)
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) throw new Error(`upsertAcuityConnection: ${error.message}`);
  return toPublicAcuityConnection(data as unknown as StoredAcuityConnectionRow);
}

/** Booking defaults chosen on the dashboard card (null clears a default). */
export async function setAcuityBookingDefaults(
  businessId: string,
  defaults: {
    defaultAppointmentTypeId?: string | null;
    defaultCalendarId?: string | null;
    defaultCalendarTimezone?: string | null;
    suppressProviderEmails?: boolean;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...("defaultAppointmentTypeId" in defaults
      ? { default_appointment_type_id: defaults.defaultAppointmentTypeId ?? null }
      : {}),
    ...("defaultCalendarId" in defaults
      ? { default_calendar_id: defaults.defaultCalendarId ?? null }
      : {}),
    ...("defaultCalendarTimezone" in defaults
      ? { default_calendar_timezone: defaults.defaultCalendarTimezone ?? null }
      : {}),
    ...(defaults.suppressProviderEmails === undefined
      ? {}
      : { suppress_provider_emails: defaults.suppressProviderEmails })
  };
  const { error } = await db
    .from("acuity_connections")
    .update(patch)
    .eq("business_id", businessId);
  if (error) throw new Error(`setAcuityBookingDefaults: ${error.message}`);
}

/** Persist the outcome of a dynamic-webhook reconcile. */
export async function setAcuityWebhookRegistration(
  businessId: string,
  registration: AcuityWebhookRegistration,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("acuity_connections")
    .update({
      webhook_registration: registration,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  if (error) throw new Error(`setAcuityWebhookRegistration: ${error.message}`);
}

export async function deleteAcuityConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("acuity_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteAcuityConnection: ${error.message}`);
}
