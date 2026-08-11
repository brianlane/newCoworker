import type { AxiosResponse } from "axios";
import { getWorkspaceOAuthConnectionByNangoIds } from "@/lib/db/workspace-oauth-connections";
import type { WorkspaceLink, WorkspaceProxyArgs, WorkspaceProxyResponse } from "@/lib/workspace/types";
import { getNangoClient } from "./server";

/**
 * Nango's name for a workspace link. Structurally identical to `WorkspaceLink`,
 * which is now the canonical type: connections are identified the same way
 * whichever transport serves them. Kept as an alias because Nango-internal
 * modules still refer to it.
 */
export type NangoWorkspaceLink = WorkspaceLink;

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

/**
 * The Nango transport: proxies an HTTP request to the provider API, with Nango
 * adding auth server-side. `link` must match a row in
 * `workspace_oauth_connections` for this business.
 *
 * Prefer `workspaceProxyForBusiness` (src/lib/workspace/proxy.ts) at call sites.
 * This function is one transport behind that seam, not the entry point: it is
 * correct only for connections Nango actually brokers. Calling it directly for a
 * first-party connection would send a Nango connection id Nango has never heard
 * of.
 *
 * THROWS on any non-2xx provider response. Nango builds its axios instance
 * without a `validateStatus` override, so axios's default (2xx only) applies
 * and a Gmail 403 or a Graph 429 arrives here as a rejection, never as a
 * returned response. Every caller that only wants "did this work" relies on
 * that: it is what keeps a failed send from being reported as a success.
 * Callers that need to BRANCH on the status code want
 * `workspaceProxyStatusForBusiness` (or `nangoProxyStatusForBusiness` below,
 * which it delegates to) instead.
 */
export async function nangoProxyForBusiness(
  businessId: string,
  link: WorkspaceLink,
  config: WorkspaceProxyArgs
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

/**
 * A provider response reduced to the two fields status-branching callers read.
 *
 * Aliased to `WorkspaceProxyResponse` rather than declared again: it is the same
 * shape the transport-neutral seam returns, and one canonical definition is what
 * lets a first-party transport satisfy this contract without a conversion step.
 */
export type ProxyStatusResponse = WorkspaceProxyResponse;

/**
 * Reads the HTTP status off a rejected proxy call, or undefined when the
 * failure carried no response at all (DNS, timeout, socket reset).
 *
 * Duck-typed rather than `axios.isAxiosError`: axios is only a devDependency
 * here (it reaches production as a transitive dep of @nangohq/node), and the
 * first-party OAuth work will eventually put a different HTTP client behind
 * this seam. `response.status` is the axios shape; a bare `status` covers a
 * client that reports it directly.
 */
function proxyErrorResponse(err: unknown): ProxyStatusResponse | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { response?: unknown; status?: unknown };
  const response =
    e.response && typeof e.response === "object"
      ? (e.response as { status?: unknown; data?: unknown })
      : undefined;
  const status = typeof response?.status === "number" ? response.status : e.status;
  if (typeof status !== "number" || !Number.isFinite(status)) return undefined;
  // Anything outside the HTTP range is some other object that happens to carry
  // a `status` field, not a provider response.
  if (status < 100 || status > 599) return undefined;
  return { status, data: response?.data };
}

/**
 * Same request as `nangoProxyForBusiness`, but a provider error response comes
 * back as `{ status, data }` instead of throwing, so a caller can tell a 403
 * (scope revoked, needs reconnect) from a 429 (back off) from a 404.
 *
 * A transport failure with no response still throws: there is no status to
 * report, and swallowing it would turn "we never reached Gmail" into a value
 * the caller would have to invent a meaning for.
 */
export async function nangoProxyStatusForBusiness(
  businessId: string,
  link: WorkspaceLink,
  config: WorkspaceProxyArgs
): Promise<ProxyStatusResponse | null> {
  try {
    const res = await nangoProxyForBusiness(businessId, link, config);
    return res ? { status: res.status, data: res.data } : null;
  } catch (err) {
    const normalized = proxyErrorResponse(err);
    if (!normalized) throw err;
    return normalized;
  }
}
