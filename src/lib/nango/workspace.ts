import type { AxiosResponse } from "axios";
import type { ProxyConfiguration } from "@nangohq/node";
import { getWorkspaceOAuthConnectionByNangoIds } from "@/lib/db/workspace-oauth-connections";
import { getNangoClient } from "./server";

export type NangoWorkspaceLink = {
  connectionId: string;
  providerConfigKey: string;
};

async function resolveVerifiedLink(
  businessId: string,
  link: NangoWorkspaceLink
): Promise<NangoWorkspaceLink | null> {
  const row = await getWorkspaceOAuthConnectionByNangoIds(
    businessId,
    link.providerConfigKey,
    link.connectionId
  );
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    providerConfigKey: row.provider_config_key
  };
}

type ProxyArgs = Omit<ProxyConfiguration, "providerConfigKey" | "connectionId">;

/**
 * Proxies an HTTP request to the provider API (adds auth server-side).
 * `link` must match a row in `workspace_oauth_connections` for this business.
 */
export async function nangoProxyForBusiness(
  businessId: string,
  link: NangoWorkspaceLink,
  config: ProxyArgs
): Promise<AxiosResponse | null> {
  const verified = await resolveVerifiedLink(businessId, link);
  if (!verified) return null;
  const nango = getNangoClient();
  return nango.proxy({
    ...config,
    providerConfigKey: verified.providerConfigKey,
    connectionId: verified.connectionId
  });
}
