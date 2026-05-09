/**
 * Per-business custom HTTP integrations.
 *
 * Owner-managed `(label, base_url, auth_scheme, secret)` triples used by
 * the Rowboat agent's `http_api_call` tool to call arbitrary REST APIs
 * without exposing the credential to the model. Schema lives in
 * `supabase/migrations/20260508220000_custom_integrations.sql`; this
 * module is the only writer of `custom_integrations` from app code.
 *
 * Secrets are AES-256-GCM via `@/lib/integrations/secrets` (same crypto
 * the existing `integrations` table uses). The decrypted secret never
 * leaves a server-side function — the dashboard listing/edit UI gets a
 * masked stub, and the agent gets the integration metadata only.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const CUSTOM_AUTH_SCHEMES = [
  "bearer",
  "header",
  "basic",
  "query",
  "none"
] as const;
export type CustomIntegrationAuthScheme = (typeof CUSTOM_AUTH_SCHEMES)[number];

/** Hard caps mirrored on the DB side (see migration). */
export const CUSTOM_LABEL_MAX = 80;
export const CUSTOM_DESCRIPTION_MAX = 500;
export const CUSTOM_HEADER_NAME_MAX = 128;
/** RFC 7230 token (`tchar`) — strict header-name validation. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

type StoredCustomIntegrationRow = {
  id: string;
  business_id: string;
  label: string;
  base_url: string;
  auth_scheme: CustomIntegrationAuthScheme;
  header_name: string | null;
  secret_encrypted: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Internal row shape with the decrypted secret in place. Only ever
 * leaves a server-side function — the dashboard / agent never sees this
 * object directly. Use `toPublicCustomIntegration` before returning to a
 * client.
 */
export type CustomIntegrationRow = Omit<
  StoredCustomIntegrationRow,
  "secret_encrypted"
> & {
  secret: string | null;
};

/**
 * Public shape returned to the dashboard UI: secret is replaced with a
 * has_secret boolean so the UI can render "stored" vs "missing" without
 * ever holding the cleartext credential in browser memory.
 */
export type PublicCustomIntegrationRow = Omit<
  StoredCustomIntegrationRow,
  "secret_encrypted"
> & {
  has_secret: boolean;
};

function toDecryptedRow(row: StoredCustomIntegrationRow): CustomIntegrationRow {
  const { secret_encrypted: encrypted, ...rest } = row;
  return {
    ...rest,
    secret: decryptIntegrationSecret(encrypted)
  };
}

export function toPublicCustomIntegration(
  row: StoredCustomIntegrationRow
): PublicCustomIntegrationRow {
  const { secret_encrypted, ...rest } = row;
  return {
    ...rest,
    has_secret: secret_encrypted !== null
  };
}

export type ListCustomIntegrationsOptions = {
  /** Drop soft-disabled rows. Default false (UI shows everything). */
  activeOnly?: boolean;
};

export async function listCustomIntegrations(
  businessId: string,
  options: ListCustomIntegrationsOptions = {},
  client?: SupabaseClient
): Promise<PublicCustomIntegrationRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  let query = db
    .from("custom_integrations")
    .select(
      "id,business_id,label,base_url,auth_scheme,header_name,secret_encrypted,description,is_active,created_at,updated_at"
    )
    .eq("business_id", businessId);
  if (options.activeOnly) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query.order("label", { ascending: true });
  if (error) throw new Error(`listCustomIntegrations: ${error.message}`);
  return ((data ?? []) as StoredCustomIntegrationRow[]).map(
    toPublicCustomIntegration
  );
}

/**
 * Escape PostgreSQL LIKE/ILIKE wildcard metacharacters so the value is
 * treated as a literal string. We escape `\`, `%`, and `_`; that lets
 * us use `.ilike()` as case-insensitive *equality* (since there's no
 * `lower(col) = lower($1)` operator on the supabase-js builder).
 *
 * Without this, an agent sending a label of `%` would match the first
 * row in the business and the proxy would gleefully forward whatever
 * credential lives there.
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Resolve a label to a single decrypted row for the proxy/tool path.
 * Case-insensitive — matches the unique index on `lower(label)` in the
 * migration; the wildcard chars are escaped so an agent cannot use
 * `%`/`_` as a fishing pattern across the business's integrations.
 *
 * Returns null when no matching row exists; callers must disambiguate
 * that from "exists but is_active=false" themselves.
 */
export async function getCustomIntegrationByLabel(
  businessId: string,
  label: string,
  client?: SupabaseClient
): Promise<CustomIntegrationRow | null> {
  const trimmed = label.trim();
  if (!trimmed) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("custom_integrations")
    .select()
    .eq("business_id", businessId)
    .ilike("label", escapeLikeLiteral(trimmed))
    .maybeSingle();
  if (error) throw new Error(`getCustomIntegrationByLabel: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as StoredCustomIntegrationRow);
}

export async function getCustomIntegrationById(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<PublicCustomIntegrationRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("custom_integrations")
    .select()
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getCustomIntegrationById: ${error.message}`);
  if (!data) return null;
  return toPublicCustomIntegration(data as StoredCustomIntegrationRow);
}

export type UpsertCustomIntegrationInput = {
  businessId: string;
  /** Defined when updating an existing row; omit/null on create. */
  id?: string | null;
  label: string;
  baseUrl: string;
  authScheme: CustomIntegrationAuthScheme;
  /** Required when authScheme is "header" or "query"; ignored otherwise. */
  headerName?: string | null;
  /**
   * Cleartext secret. Encrypted before write. Pass `null` to clear the
   * stored secret (only valid when authScheme="none"); pass `undefined`
   * to leave the existing stored value untouched on an update.
   */
  secret?: string | null;
  description?: string | null;
  isActive?: boolean;
};

/**
 * Validation that mirrors the DB CHECK constraints + a couple of
 * additional guardrails (private network blocks, scheme/header_name
 * cross-checks) that PostgreSQL can't easily express. Throws a plain
 * Error with a stable `code` field on the first failure so the route
 * handler can surface a 400 instead of a 500.
 */
export type CustomIntegrationValidationCode =
  | "label_invalid"
  | "label_too_long"
  | "base_url_invalid"
  | "base_url_private"
  | "auth_scheme_invalid"
  | "header_name_required"
  | "header_name_invalid"
  | "secret_required"
  | "description_too_long";

export class CustomIntegrationValidationError extends Error {
  constructor(public readonly validationCode: CustomIntegrationValidationCode, message: string) {
    super(message);
    this.name = "CustomIntegrationValidationError";
  }
}

/**
 * Network sanity check: refuse to register / call private/loopback
 * hosts so the agent can't be tricked into hitting cloud-metadata
 * endpoints (169.254.169.254) or LAN admin panels via a stored credential.
 *
 * Exported so the proxy route can re-validate at call time (defense in
 * depth: a row written before this guard existed must still be blocked).
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  // Bare `localhost` and any `*.localhost` subdomain. The latter resolves
  // to loopback via systemd-resolved / dnsmasq / mDNS depending on the
  // environment; the proxy's call-time `assertSafeHostname` rejects
  // them too, so we MUST refuse them at registration.
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv4 dotted-quad?
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    if (o[0] === 10) return true;
    if (o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 0) return true;
  }
  // Common cloud-metadata hostnames worth blocking explicitly.
  if (
    h === "metadata.google.internal" ||
    h === "metadata" ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  return false;
}

/**
 * Returns true when the host literal is a bare IP address (v4 or v6).
 * The proxy's call-time `assertSafeHostname` rejects ALL bare IPs, so
 * we must reject them at registration time too — otherwise an owner
 * can register a row that simply never works at call time. Real REST
 * APIs are vhosted and reachable by hostname; if you really need to
 * point at an IP, do it via DNS.
 */
export function isBareIpHost(host: string): boolean {
  // IPv4 dotted-quad with valid octets.
  const m4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4 && m4.slice(1).map(Number).every((n) => n <= 255)) {
    return true;
  }
  // IPv6: any colon in the hostname disqualifies it as a registered name.
  // (`URL` strips brackets from `url.hostname`, so we see e.g. "::1"
  // not "[::1]".)
  if (host.includes(":")) return true;
  return false;
}

export type ParsedBaseUrl = {
  origin: string;
  pathPrefix: string;
};

/**
 * Parse and normalize a base URL. Throws CustomIntegrationValidationError
 * on any defect so callers get a stable, surface-able failure code.
 */
export function parseBaseUrl(input: string): ParsedBaseUrl {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CustomIntegrationValidationError(
      "base_url_invalid",
      "base_url is not a valid URL"
    );
  }
  if (url.protocol !== "https:") {
    throw new CustomIntegrationValidationError(
      "base_url_invalid",
      "base_url must use https://"
    );
  }
  /* c8 ignore start -- defensive: WHATWG URL constructor already rejects URLs without a hostname */
  if (!url.hostname) {
    throw new CustomIntegrationValidationError(
      "base_url_invalid",
      "base_url is missing a hostname"
    );
  }
  /* c8 ignore stop */
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw new CustomIntegrationValidationError(
      "base_url_private",
      "base_url points at a private/loopback host"
    );
  }
  // Bare IPv4/IPv6 literals are refused at registration time so the
  // proxy's call-time bare-IP refusal in `assertSafeHostname` cannot
  // produce silent "registered but never callable" rows.
  if (isBareIpHost(url.hostname)) {
    throw new CustomIntegrationValidationError(
      "base_url_invalid",
      "base_url must be a hostname, not a bare IP literal"
    );
  }
  if (url.username || url.password) {
    throw new CustomIntegrationValidationError(
      "base_url_invalid",
      "base_url must not include userinfo (user:pass@…)"
    );
  }
  // Drop trailing slash from path so concat with a leading-slash path is
  // unambiguous. WHATWG URL always gives a non-empty pathname (at minimum
  // "/"), so the `|| "/"` fallback is purely defensive.
  /* c8 ignore next -- WHATWG URL always populates pathname; fallback is structural */
  let pathPrefix = url.pathname || "/";
  if (pathPrefix !== "/" && pathPrefix.endsWith("/")) {
    pathPrefix = pathPrefix.slice(0, -1);
  }
  if (url.search || url.hash) {
    throw new CustomIntegrationValidationError(
      "base_url_invalid",
      "base_url must not include query or fragment"
    );
  }
  return { origin: url.origin, pathPrefix };
}

export function validateUpsertInput(input: UpsertCustomIntegrationInput): void {
  const trimmedLabel = input.label.trim();
  if (!trimmedLabel) {
    throw new CustomIntegrationValidationError(
      "label_invalid",
      "label is required"
    );
  }
  if (trimmedLabel.length > CUSTOM_LABEL_MAX) {
    throw new CustomIntegrationValidationError(
      "label_too_long",
      `label exceeds ${CUSTOM_LABEL_MAX} characters`
    );
  }
  if (/[\u0000-\u001f]/.test(trimmedLabel)) {
    throw new CustomIntegrationValidationError(
      "label_invalid",
      "label must not contain control characters"
    );
  }
  parseBaseUrl(input.baseUrl);
  if (!CUSTOM_AUTH_SCHEMES.includes(input.authScheme)) {
    throw new CustomIntegrationValidationError(
      "auth_scheme_invalid",
      "auth_scheme is invalid"
    );
  }
  const needsHeaderName =
    input.authScheme === "header" || input.authScheme === "query";
  const headerName = input.headerName?.trim() || null;
  if (needsHeaderName) {
    if (!headerName) {
      throw new CustomIntegrationValidationError(
        "header_name_required",
        "header_name is required when auth_scheme is header or query"
      );
    }
    if (headerName.length > CUSTOM_HEADER_NAME_MAX) {
      throw new CustomIntegrationValidationError(
        "header_name_invalid",
        `header_name exceeds ${CUSTOM_HEADER_NAME_MAX} characters`
      );
    }
    if (!HEADER_NAME_PATTERN.test(headerName)) {
      throw new CustomIntegrationValidationError(
        "header_name_invalid",
        "header_name has invalid characters"
      );
    }
  }
  // On create (no id), require a secret unless scheme is "none". On update
  // (id present) we let `secret === undefined` mean "leave existing value
  // alone", so we cannot detect "never had one" here — that's enforced
  // by the DB row's existing state, plus the route layer fetches the
  // current row and refuses to flip scheme→bearer/header/basic/query
  // without supplying a secret.
  if (!input.id && input.authScheme !== "none") {
    if (input.secret === null || input.secret === undefined || input.secret === "") {
      throw new CustomIntegrationValidationError(
        "secret_required",
        "secret is required for this auth_scheme"
      );
    }
  }
  const desc = input.description?.trim() ?? "";
  if (desc.length > CUSTOM_DESCRIPTION_MAX) {
    throw new CustomIntegrationValidationError(
      "description_too_long",
      `description exceeds ${CUSTOM_DESCRIPTION_MAX} characters`
    );
  }
}

/**
 * Normalize the header_name column for a row that's about to be
 * written. Validation has already enforced that `name` is a non-empty
 * string when `scheme` is "header" or "query", so we trust that here
 * and only branch on the scheme: schemes that don't use a header_name
 * always store NULL, the rest store the trimmed input.
 */
function normalizeHeaderName(
  scheme: CustomIntegrationAuthScheme,
  name: string | null | undefined
): string | null {
  if (scheme !== "header" && scheme !== "query") return null;
  // Validation guarantees a non-empty string here; non-null assertion
  // documents the precondition for the type checker.
  return (name as string).trim();
}

/**
 * Empty/whitespace description should be stored as NULL rather than as
 * an empty string. Pulled out so create + update share one definition.
 */
function normalizeDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function createCustomIntegration(
  input: UpsertCustomIntegrationInput,
  client?: SupabaseClient
): Promise<PublicCustomIntegrationRow> {
  validateUpsertInput({ ...input, id: null });
  const db = client ?? (await createSupabaseServiceClient());
  const row = {
    business_id: input.businessId,
    label: input.label.trim(),
    base_url: input.baseUrl.trim(),
    auth_scheme: input.authScheme,
    header_name: normalizeHeaderName(input.authScheme, input.headerName),
    secret_encrypted:
      input.authScheme === "none"
        ? null
        : // Validation guarantees a non-empty secret here when the
          // scheme is not "none"; the encrypter happily handles the
          // string directly.
          encryptIntegrationSecret(input.secret as string),
    description: normalizeDescription(input.description),
    is_active: input.isActive ?? true
  };
  const { data, error } = await db
    .from("custom_integrations")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`createCustomIntegration: ${error.message}`);
  return toPublicCustomIntegration(data as StoredCustomIntegrationRow);
}

/**
 * Compute the secret_encrypted patch slot for an update. Three cases:
 *   - scheme === "none" → always clear, so a later flip to a
 *     credentialed scheme cannot resurrect a stale credential.
 *   - non-empty secret string supplied → encrypt and write.
 *   - otherwise (undefined / null / empty) → leave the stored secret
 *     alone. We DO NOT include `secret_encrypted` in the patch object.
 *
 * Empty-string and null are folded into "leave alone" deliberately:
 * the dashboard form sends an empty string when the owner doesn't want
 * to rotate the credential, and we must not interpret that as "clear
 * the secret" (the scheme would then be enabled with no credential and
 * every agent call would 502).
 */
function computeSecretPatch(
  input: UpsertCustomIntegrationInput
): { include: true; value: string | null } | { include: false } {
  if (input.authScheme === "none") {
    return { include: true, value: null };
  }
  if (typeof input.secret === "string" && input.secret.length > 0) {
    return { include: true, value: encryptIntegrationSecret(input.secret) };
  }
  return { include: false };
}

/**
 * Returns whether the stored row already has a secret on file. Used by
 * `updateCustomIntegration` to refuse a scheme→credentialed transition
 * that would leave the row with no usable credential. A missing row
 * (cross-tenant id, race) or a null `secret_encrypted` are both treated
 * as "no secret" and surface the same error to the caller.
 */
async function storedRowHasSecret(
  db: SupabaseClient,
  businessId: string,
  id: string
): Promise<boolean> {
  const { data, error } = await db
    .from("custom_integrations")
    .select("secret_encrypted")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`updateCustomIntegration: ${error.message}`);
  }
  const row = data as { secret_encrypted: string | null } | null;
  return row !== null && row.secret_encrypted !== null;
}

/**
 * `updateCustomIntegration` invariant guard: refuse a transition that
 * would leave the row with a credentialed scheme but no usable secret.
 * Pulled out as a free function so the logic is exhaustively branch-
 * coverable without nesting `&&` chains in the call site.
 */
async function assertCredentialedSchemeHasSecret(
  input: UpsertCustomIntegrationInput & { id: string },
  secretPatch: ReturnType<typeof computeSecretPatch>,
  db: SupabaseClient
): Promise<void> {
  if (input.authScheme === "none") return;
  if (secretPatch.include) return;
  const hasStored = await storedRowHasSecret(db, input.businessId, input.id);
  if (hasStored) return;
  throw new CustomIntegrationValidationError(
    "secret_required",
    "secret is required for this auth_scheme"
  );
}

export async function updateCustomIntegration(
  input: UpsertCustomIntegrationInput & { id: string },
  client?: SupabaseClient
): Promise<PublicCustomIntegrationRow> {
  validateUpsertInput(input);
  const db = client ?? (await createSupabaseServiceClient());
  const secretPatch = computeSecretPatch(input);
  // Defense in depth: if the caller is selecting a credentialed scheme
  // without supplying a new secret, the stored row MUST already have a
  // secret. Otherwise the update silently produces a row that the
  // proxy can never honor.
  await assertCredentialedSchemeHasSecret(input, secretPatch, db);
  const patch: Record<string, unknown> = {
    label: input.label.trim(),
    base_url: input.baseUrl.trim(),
    auth_scheme: input.authScheme,
    header_name: normalizeHeaderName(input.authScheme, input.headerName),
    description: normalizeDescription(input.description),
    is_active: input.isActive ?? true,
    ...(secretPatch.include ? { secret_encrypted: secretPatch.value } : {})
  };
  const { data, error } = await db
    .from("custom_integrations")
    .update(patch)
    .eq("business_id", input.businessId)
    .eq("id", input.id)
    .select()
    .single();
  if (error) throw new Error(`updateCustomIntegration: ${error.message}`);
  return toPublicCustomIntegration(data as StoredCustomIntegrationRow);
}

export async function deleteCustomIntegration(
  businessId: string,
  id: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("custom_integrations")
    .delete()
    .eq("business_id", businessId)
    .eq("id", id);
  if (error) throw new Error(`deleteCustomIntegration: ${error.message}`);
}
