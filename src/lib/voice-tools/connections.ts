import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";

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
// tools without reconnecting. Calendly sits after the native calendars
// (it can only hand out booking links, not create events) but before the
// broad workspace fallbacks (a deliberate Calendly connect should win over
// an incidental all-in-one Google connect).
const CALENDAR_KEYS = [
  "google-calendar",
  "outlook-calendar",
  "calendly",
  "google",
  "outlook"
] as const;
export const EMAIL_PROVIDER_CONFIG_KEYS = ["google-mail", "gmail", "outlook"] as const;
const EMAIL_KEYS = EMAIL_PROVIDER_CONFIG_KEYS;

export type ResolvedVoiceConnection = {
  provider: "google" | "microsoft" | "calendly";
  providerConfigKey: string;
  connectionId: string;
};

export function providerFromKey(key: string): "google" | "microsoft" {
  return key.startsWith("google") || key === "gmail" ? "google" : "microsoft";
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

export function resolveCalendarConnection(businessId: string) {
  return resolveVoiceConnection(businessId, CALENDAR_KEYS);
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
