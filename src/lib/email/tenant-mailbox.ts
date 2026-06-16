/**
 * Per-tenant AI coworker mailbox helpers.
 *
 * Every business owns ONE address at the platform email domain — the AI
 * coworker's own inbox, distinct from the platform team inbox and from the
 * owner's Nango-connected Gmail/Outlook. The default local-part is the
 * business UUID (guaranteed-unique, zero setup); standard/enterprise tiers
 * may personalize it to a friendly handle.
 *
 * Inbound mail is caught by Cloudflare Email Routing's catch-all -> Email
 * Worker -> /api/email/inbound, which calls `resolveBusinessByAddress` to map
 * the recipient back to a tenant. Outbound flow sends use `tenantMailboxAddress`
 * as the Resend `from`.
 *
 * Reads/writes go through the service-role client (the table is RLS-locked with
 * no policies), so callers must be server-side.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Tiers allowed to personalize their mailbox handle. */
export const PERSONALIZE_TIERS = new Set(["standard", "enterprise"]);

/**
 * Local-parts an owner may never claim. Includes the two real Cloudflare Email
 * Routing rules (`contact@`, `team@` -> the platform Gmail) so a tenant can
 * never shadow platform mail, plus the usual role-address reservations.
 */
export const RESERVED_LOCAL_PARTS = new Set([
  "contact",
  "team",
  "support",
  "admin",
  "administrator",
  "hello",
  "help",
  "info",
  "billing",
  "sales",
  "security",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "newcoworker",
  "newcoworkerteam"
]);

/** Just the slice of env this module reads — lets tests pass partial objects. */
type DomainEnv = Record<string, string | undefined>;

/** The domain tenant mailboxes live under (e.g. "newcoworker.com"). */
export function tenantEmailDomain(env: DomainEnv = process.env): string {
  const raw = env.TENANT_EMAIL_DOMAIN;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed.toLowerCase() : "newcoworker.com";
}

/** A custom-handle constraint stricter than the DB CHECK (no trailing punctuation). */
const PERSONALIZED_LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/;
/** Minimum length for a personalized handle (the UUID default is exempt). */
export const PERSONALIZED_MIN_LENGTH = 3;
export const LOCAL_PART_MAX_LENGTH = 64;

export type TenantMailboxRow = {
  business_id: string;
  local_part: string;
  personalized: boolean;
  created_at: string;
  updated_at: string;
};

const MAILBOX_COLS = "business_id, local_part, personalized, created_at, updated_at";

export type MailboxErrorCode =
  | "tier_not_eligible"
  | "invalid_format"
  | "reserved"
  | "taken";

export class TenantMailboxError extends Error {
  constructor(
    message: string,
    public readonly code: MailboxErrorCode
  ) {
    super(message);
    this.name = "TenantMailboxError";
  }
}

async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

/** Full address for a local-part, e.g. "amy" -> "amy@newcoworker.com". */
export function tenantMailboxAddress(
  localPart: string,
  env: DomainEnv = process.env
): string {
  return `${localPart.toLowerCase()}@${tenantEmailDomain(env)}`;
}

/**
 * Parse the bare local-part out of a recipient header value. Accepts both a
 * raw address ("amy@newcoworker.com") and a display form
 * ("Amy <amy@newcoworker.com>"); returns null when there's no "@".
 */
export function parseLocalPart(address: string): string | null {
  const m = /<([^<>]+)>/.exec(address);
  const bare = (m ? m[1] : address).trim().toLowerCase();
  const at = bare.lastIndexOf("@");
  if (at <= 0) return null;
  return bare.slice(0, at);
}

type LocalPartValidation =
  | { ok: true; localPart: string }
  | { ok: false; code: MailboxErrorCode; message: string };

/** Validate + normalize a personalized handle without throwing. */
export function validatePersonalizedLocalPart(raw: string): LocalPartValidation {
  const localPart = raw.trim().toLowerCase();
  if (
    localPart.length < PERSONALIZED_MIN_LENGTH ||
    localPart.length > LOCAL_PART_MAX_LENGTH ||
    !PERSONALIZED_LOCAL_PART_RE.test(localPart)
  ) {
    return {
      ok: false,
      code: "invalid_format",
      message: `Handle must be ${PERSONALIZED_MIN_LENGTH}-${LOCAL_PART_MAX_LENGTH} characters using letters, numbers, dot, dash or underscore (and start/end alphanumeric).`
    };
  }
  if (RESERVED_LOCAL_PARTS.has(localPart)) {
    return { ok: false, code: "reserved", message: "That handle is reserved." };
  }
  return { ok: true, localPart };
}

/** Validate + normalize a personalized handle. Throws TenantMailboxError. */
export function normalizePersonalizedLocalPart(raw: string): string {
  const result = validatePersonalizedLocalPart(raw);
  if (!result.ok) throw new TenantMailboxError(result.message, result.code);
  return result.localPart;
}

/**
 * Derive a friendly default handle suggestion from a business name. Returns a
 * best-effort slug, or "" when nothing usable remains (caller falls back to the
 * UUID default). NOT guaranteed unique — the availability check owns that.
 */
export function suggestLocalPartFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LOCAL_PART_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (slug.length < PERSONALIZED_MIN_LENGTH) return "";
  if (RESERVED_LOCAL_PARTS.has(slug)) return "";
  return slug;
}

/** The mailbox row for a business, or null when none reserved yet. */
export async function getTenantMailbox(
  businessId: string,
  client?: SupabaseClient
): Promise<TenantMailboxRow | null> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("tenant_mailboxes")
    .select(MAILBOX_COLS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getTenantMailbox: ${error.message}`);
  return (data as TenantMailboxRow | null) ?? null;
}

/**
 * Reserve the default (UUID) mailbox for a business if one doesn't exist.
 * Idempotent: a conflicting insert (row already present) is swallowed and the
 * existing row returned, so re-provisioning is safe.
 */
export async function ensureTenantMailbox(
  businessId: string,
  client?: SupabaseClient
): Promise<TenantMailboxRow> {
  const db = await resolveDb(client);
  const existing = await getTenantMailbox(businessId, db);
  if (existing) return existing;
  const { data, error } = await db
    .from("tenant_mailboxes")
    .insert({ business_id: businessId, local_part: businessId.toLowerCase(), personalized: false })
    .select(MAILBOX_COLS)
    .single();
  if (error) {
    // 23505: a concurrent provision created it first — return that row.
    if ((error as { code?: string }).code === "23505") {
      const row = await getTenantMailbox(businessId, db);
      if (row) return row;
    }
    throw new Error(`ensureTenantMailbox: ${error.message}`);
  }
  return data as TenantMailboxRow;
}

/** Resolve a businessId from a bare local-part (case-insensitive). */
export async function resolveBusinessByLocalPart(
  localPart: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("tenant_mailboxes")
    .select("business_id")
    .eq("local_part", localPart.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`resolveBusinessByLocalPart: ${error.message}`);
  return (data as { business_id: string } | null)?.business_id ?? null;
}

/**
 * Resolve a businessId from a full recipient address. Returns null when the
 * domain doesn't match the platform domain or the local-part isn't claimed.
 */
export async function resolveBusinessByAddress(
  address: string,
  client?: SupabaseClient,
  env: DomainEnv = process.env
): Promise<string | null> {
  const bare = (() => {
    const m = /<([^<>]+)>/.exec(address);
    return (m ? m[1] : address).trim().toLowerCase();
  })();
  const at = bare.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = bare.slice(at + 1);
  if (domain !== tenantEmailDomain(env)) return null;
  const localPart = bare.slice(0, at);
  return resolveBusinessByLocalPart(localPart, client);
}

export type AvailabilityResult = { available: boolean; reason?: MailboxErrorCode };

/**
 * Whether a personalized handle is free to claim. Validates format + reserved
 * list first (cheap, no IO), then checks the unique index — excluding the
 * caller's own current row so re-saving the same handle reads as available.
 */
export async function checkLocalPartAvailable(
  rawLocalPart: string,
  businessId: string,
  client?: SupabaseClient
): Promise<AvailabilityResult> {
  const validation = validatePersonalizedLocalPart(rawLocalPart);
  if (!validation.ok) return { available: false, reason: validation.code };
  const localPart = validation.localPart;
  const db = await resolveDb(client);
  const { data, error } = await db
    .from("tenant_mailboxes")
    .select("business_id")
    .eq("local_part", localPart)
    .maybeSingle();
  if (error) throw new Error(`checkLocalPartAvailable: ${error.message}`);
  const owner = (data as { business_id: string } | null)?.business_id ?? null;
  if (owner && owner !== businessId) return { available: false, reason: "taken" };
  return { available: true };
}

/**
 * Set a personalized handle for a business. Enforces the tier gate, format +
 * reserved checks, then the uniqueness constraint (a race that slips past the
 * pre-check is caught by the unique index's 23505). Creates the row if the
 * business somehow has none yet.
 */
export async function setPersonalizedLocalPart(
  args: { businessId: string; tier: string; localPart: string },
  client?: SupabaseClient
): Promise<TenantMailboxRow> {
  if (!PERSONALIZE_TIERS.has(args.tier)) {
    throw new TenantMailboxError(
      "Personalizing the AI mailbox is available on the Standard plan and above.",
      "tier_not_eligible"
    );
  }
  // Throws on format/reserved; after this the only availability failure left
  // is "taken" (another business already claimed the handle).
  const localPart = normalizePersonalizedLocalPart(args.localPart);
  const db = await resolveDb(client);

  const availability = await checkLocalPartAvailable(localPart, args.businessId, db);
  if (!availability.available) {
    throw new TenantMailboxError("That handle is already taken.", "taken");
  }

  const { data, error } = await db
    .from("tenant_mailboxes")
    .upsert(
      {
        business_id: args.businessId,
        local_part: localPart,
        personalized: true,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id" }
    )
    .select(MAILBOX_COLS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new TenantMailboxError("That handle is already taken.", "taken");
    }
    throw new Error(`setPersonalizedLocalPart: ${error.message}`);
  }
  return data as TenantMailboxRow;
}
