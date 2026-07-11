import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { getActiveVagaroConnectionId } from "@/lib/db/vagaro-connections";
import { getActiveCalendlyConnectionId } from "@/lib/db/calendly-connections";
import { getActiveCaldavConnectionId } from "@/lib/db/caldav-connections";

/**
 * Provider-config key groupings for voice tools.
 *
 * Nango uses its own identifier per provider config; we stored these when the
 * owner completed the Connect UI. For each logical capability (calendar,
 * email) we prefer Google if connected, otherwise fall back to Microsoft.
 */
// Dedicated calendar connections first; the broad full-scope "google" /
// "outlook" workspace connections (which include calendar read/write) act as
// fallbacks so owners who connected the all-in-one integration get calendar
// tools without reconnecting. Calendly (Nango OAuth or the dashboard PAT —
// see CALENDLY_DIRECT_KEY) sits after the native calendars (it can only
// hand out booking links, not create events) but before the broad workspace
// fallbacks (a deliberate Calendly connect should win over an incidental
// all-in-one Google connect).
const NATIVE_CALENDAR_KEYS = ["google-calendar", "outlook-calendar"] as const;
const FALLBACK_CALENDAR_KEYS = ["calendly", "google", "outlook"] as const;

/**
 * Synthetic providerConfigKey marking a DIRECT Calendly connection (owner
 * pasted a Personal Access Token on the dashboard, stored in
 * `calendly_connections`) as opposed to the Nango OAuth key "calendly".
 * The calendar-tools Calendly cores pick their HTTP transport off this.
 */
export const CALENDLY_DIRECT_KEY = "calendly-direct";

/**
 * Synthetic providerConfigKey marking a DIRECT CalDAV connection (owner
 * pasted server URL + app-specific password on the dashboard, stored in
 * `caldav_connections`). There is no Nango CalDAV path — this is the only
 * key for the provider.
 */
export const CALDAV_DIRECT_KEY = "caldav-direct";
export const EMAIL_PROVIDER_CONFIG_KEYS = ["google-mail", "gmail", "outlook"] as const;
const EMAIL_KEYS = EMAIL_PROVIDER_CONFIG_KEYS;

export type ResolvedVoiceConnection = {
  provider: "google" | "microsoft" | "calendly" | "vagaro" | "caldav";
  providerConfigKey: string;
  connectionId: string;
};

export function providerFromKey(key: string): "google" | "microsoft" {
  return key.startsWith("google") || key === "gmail" ? "google" : "microsoft";
}

/**
 * True for the providers that expose a real Google/Microsoft calendar via
 * the Nango proxy — the shared "NewCoworker" calendar and the calendar
 * trigger polling only exist for these; Calendly/Vagaro connections have
 * neither concept.
 */
export function isWorkspaceCalendarProvider(
  provider: ResolvedVoiceConnection["provider"]
): provider is "google" | "microsoft" {
  return provider === "google" || provider === "microsoft";
}

/**
 * Calendar-aware provider mapping. `providerFromKey` stays binary (it is the
 * email-path helper and its callers' types depend on that); calendar
 * resolution needs the third arm so handlers can fork on Calendly.
 */
function calendarProviderFromKey(key: string): ResolvedVoiceConnection["provider"] {
  if (key === "calendly") return "calendly";
  return providerFromKey(key);
}

/** True when a stored provider_config_key is a sendable email mailbox. */
export function isEmailProviderConfigKey(key: string): boolean {
  return (EMAIL_PROVIDER_CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Returns the first connection that matches any of `preferredKeys`, in the
 * order listed. Lets callers keep "Google first, Microsoft second" without
 * forking the code per provider.
 */
export async function resolveVoiceConnection(
  businessId: string,
  preferredKeys: readonly string[]
): Promise<ResolvedVoiceConnection | null> {
  const rows = await listWorkspaceOAuthConnections(businessId);
  return firstMatch(rows, preferredKeys);
}

type WorkspaceRow = Awaited<ReturnType<typeof listWorkspaceOAuthConnections>>[number];

function firstMatch(
  rows: readonly WorkspaceRow[],
  preferredKeys: readonly string[]
): ResolvedVoiceConnection | null {
  for (const key of preferredKeys) {
    const match = rows.find((r) => r.provider_config_key === key);
    if (match) {
      return {
        provider: calendarProviderFromKey(match.provider_config_key),
        providerConfigKey: match.provider_config_key,
        connectionId: match.connection_id
      };
    }
  }
  return null;
}

export async function resolveCalendarConnection(
  businessId: string
): Promise<ResolvedVoiceConnection | null> {
  // Vagaro is the business's REAL book when connected (dedicated scheduling
  // platform, not a workspace side calendar) — it wins over every Nango
  // connection. Id-only probe: no secret decryption on this hot path.
  const vagaroId = await getActiveVagaroConnectionId(businessId);
  if (vagaroId) {
    return { provider: "vagaro", providerConfigKey: "vagaro", connectionId: vagaroId };
  }

  const rows = await listWorkspaceOAuthConnections(businessId);
  const native = firstMatch(rows, NATIVE_CALENDAR_KEYS);
  if (native) return native;

  // Direct CalDAV (iCloud app-specific password etc.) sits after the
  // dedicated Google/Outlook calendars but ahead of Calendly: it supports
  // REAL free/busy + booking, while Calendly can only hand out links.
  const directCaldavId = await getActiveCaldavConnectionId(businessId);
  if (directCaldavId) {
    return {
      provider: "caldav",
      providerConfigKey: CALDAV_DIRECT_KEY,
      connectionId: directCaldavId
    };
  }

  // Direct (PAT) Calendly occupies the same priority slot as the Nango
  // "calendly" key: after the dedicated Google/Outlook calendars, before
  // the broad workspace fallbacks. When both exist the direct connection
  // wins — pasting a PAT is the more deliberate act.
  const directCalendlyId = await getActiveCalendlyConnectionId(businessId);
  if (directCalendlyId) {
    return {
      provider: "calendly",
      providerConfigKey: CALENDLY_DIRECT_KEY,
      connectionId: directCalendlyId
    };
  }

  return firstMatch(rows, FALLBACK_CALENDAR_KEYS);
}

/** A mailbox connection is always Google or Microsoft — never Calendly. */
export type ResolvedEmailConnection = ResolvedVoiceConnection & {
  provider: "google" | "microsoft";
};

export async function resolveEmailConnection(
  businessId: string
): Promise<ResolvedEmailConnection | null> {
  // Safe narrow: EMAIL_KEYS contains no "calendly" entry, so
  // calendarProviderFromKey can only have produced google/microsoft here.
  return (await resolveVoiceConnection(businessId, EMAIL_KEYS)) as ResolvedEmailConnection | null;
}
