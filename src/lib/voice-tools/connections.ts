import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";

/**
 * Provider-config key groupings for voice tools.
 *
 * Nango uses its own identifier per provider config; we stored these when the
 * owner completed the Connect UI. For each logical capability (calendar,
 * email) we prefer Google if connected, otherwise fall back to Microsoft.
 */
const CALENDAR_KEYS = ["google-calendar", "outlook-calendar"] as const;
const EMAIL_KEYS = ["google-mail", "gmail", "outlook"] as const;

export type ResolvedVoiceConnection = {
  provider: "google" | "microsoft";
  providerConfigKey: string;
  connectionId: string;
};

function providerFromKey(key: string): "google" | "microsoft" {
  return key.startsWith("google") || key === "gmail" ? "google" : "microsoft";
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
        provider: providerFromKey(match.provider_config_key),
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

export function resolveEmailConnection(businessId: string) {
  return resolveVoiceConnection(businessId, EMAIL_KEYS);
}
