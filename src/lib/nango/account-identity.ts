/**
 * Resolve the ACTUAL provider account behind a Nango workspace connection.
 *
 * The Connect UI only knows our `end_user` (the dashboard login that started
 * the session) — it never learns which Google/Microsoft account the owner
 * picked on the consent screen. Labeling connections with `end_user.email`
 * therefore shows the same login address for every account (and the wrong
 * From address in the email log). This module asks the provider itself, via
 * the Nango proxy, "whose account is this token for?".
 *
 * Best-effort by design: a failed lookup returns nulls and the connect flow
 * proceeds with the provider-name fallback label — it must never block a
 * successful OAuth connect.
 */

import { nangoProxyForBusiness, type NangoWorkspaceLink } from "./workspace";

export type ProviderAccountIdentity = {
  email: string | null;
  displayName: string | null;
};

type IdentityAttempt = {
  endpoint: string;
  extract: (data: unknown) => ProviderAccountIdentity | null;
};

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Gmail profile — works with any gmail.* scope. `{ emailAddress }`. */
function extractGmailProfile(data: unknown): ProviderAccountIdentity | null {
  const email = nonEmpty(asRecord(data).emailAddress);
  return email ? { email, displayName: null } : null;
}

/** Google Calendar primary calendar — its `id` IS the account email. */
function extractGoogleCalendarPrimary(data: unknown): ProviderAccountIdentity | null {
  const o = asRecord(data);
  const email = nonEmpty(o.id);
  return email ? { email, displayName: nonEmpty(o.summary) } : null;
}

/** Microsoft Graph /me — `mail` is null on some tenants; UPN is the fallback. */
function extractGraphMe(data: unknown): ProviderAccountIdentity | null {
  const o = asRecord(data);
  const email = nonEmpty(o.mail) ?? nonEmpty(o.userPrincipalName);
  const displayName = nonEmpty(o.displayName);
  if (!email && !displayName) return null;
  return { email, displayName };
}

/** Zoom /v2/users/me. */
function extractZoomMe(data: unknown): ProviderAccountIdentity | null {
  const o = asRecord(data);
  const email = nonEmpty(o.email);
  const displayName =
    nonEmpty(o.display_name) ??
    (nonEmpty(o.first_name) || nonEmpty(o.last_name)
      ? [nonEmpty(o.first_name), nonEmpty(o.last_name)].filter(Boolean).join(" ")
      : null);
  if (!email && !displayName) return null;
  return { email, displayName };
}

/** Calendly /users/me — payload nests under `resource`. */
function extractCalendlyMe(data: unknown): ProviderAccountIdentity | null {
  const resource = asRecord(asRecord(data).resource);
  const email = nonEmpty(resource.email);
  const displayName = nonEmpty(resource.name);
  if (!email && !displayName) return null;
  return { email, displayName };
}

const GMAIL_PROFILE: IdentityAttempt = {
  endpoint: "/gmail/v1/users/me/profile",
  extract: extractGmailProfile
};
const GOOGLE_CALENDAR_PRIMARY: IdentityAttempt = {
  endpoint: "/calendar/v3/calendars/primary",
  extract: extractGoogleCalendarPrimary
};
const GRAPH_ME: IdentityAttempt = { endpoint: "/v1.0/me", extract: extractGraphMe };
const ZOOM_ME: IdentityAttempt = { endpoint: "/v2/users/me", extract: extractZoomMe };
const CALENDLY_ME: IdentityAttempt = { endpoint: "/users/me", extract: extractCalendlyMe };

/**
 * Ordered identity probes per provider-config key. The broad "google"
 * integration may or may not carry gmail scopes, so it tries the Gmail
 * profile first and falls back to the primary-calendar id.
 */
export function identityAttemptsForProviderKey(providerConfigKey: string): IdentityAttempt[] {
  const key = providerConfigKey.toLowerCase();
  if (key === "gmail" || key === "google-mail") return [GMAIL_PROFILE];
  if (key === "google") return [GMAIL_PROFILE, GOOGLE_CALENDAR_PRIMARY];
  if (key === "google-calendar") return [GOOGLE_CALENDAR_PRIMARY];
  if (key === "outlook" || key === "outlook-calendar" || key === "onedrive") return [GRAPH_ME];
  if (key === "zoom") return [ZOOM_ME];
  if (key === "calendly") return [CALENDLY_ME];
  return [];
}

/** GET the endpoint with the connection's auth; null = could not fetch. */
export type IdentityProxyFn = (endpoint: string) => Promise<{ data: unknown } | null>;

/**
 * Run the identity probes for a provider key through an arbitrary proxy
 * transport. Split from `fetchProviderAccountIdentity` so operator scripts
 * (which build their own Nango client rather than importing the Next-coupled
 * business proxy) reuse the exact same probe order and extraction.
 */
export async function probeProviderAccountIdentity(
  providerConfigKey: string,
  proxy: IdentityProxyFn
): Promise<ProviderAccountIdentity> {
  for (const attempt of identityAttemptsForProviderKey(providerConfigKey)) {
    try {
      const res = await proxy(attempt.endpoint);
      if (!res) continue;
      const identity = attempt.extract(res.data);
      if (identity) return identity;
    } catch {
      // Best-effort: a missing scope / provider hiccup falls through to the
      // next probe (or the null identity) rather than failing the connect.
    }
  }
  return { email: null, displayName: null };
}

/**
 * Ask the provider (through the Nango proxy, which re-verifies the link
 * belongs to the business) for the connected account's email/display name.
 * Returns nulls when the provider is unknown or every probe fails.
 */
export async function fetchProviderAccountIdentity(
  businessId: string,
  link: NangoWorkspaceLink
): Promise<ProviderAccountIdentity> {
  return probeProviderAccountIdentity(link.providerConfigKey, (endpoint) =>
    nangoProxyForBusiness(businessId, link, { endpoint, method: "GET" })
  );
}

/**
 * Metadata keys stored on `workspace_oauth_connections.metadata`. Read
 * everywhere labels are built (integrations list, AiFlow mailbox picker,
 * composer send-from options, email-log From address).
 */
export function providerAccountMetadata(
  identity: ProviderAccountIdentity
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (identity.email) meta.provider_account_email = identity.email;
  if (identity.displayName) meta.provider_account_display_name = identity.displayName;
  return meta;
}
