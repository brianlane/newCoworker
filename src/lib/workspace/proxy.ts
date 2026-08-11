/**
 * The single seam every workspace (Gmail / Calendar / Microsoft Graph) API call
 * goes through, and the one place that decides HOW to reach the provider.
 *
 * Why this exists as its own module rather than as a change inside
 * `src/lib/nango/workspace.ts`: the responsibility is different. That module
 * knows how to call Nango. This one knows which transport a given connection
 * belongs to. Google Workspace is moving to a first-party OAuth client while
 * Microsoft stays brokered by Nango, so two transports have to coexist, and the
 * choice belongs in one place rather than branched across the dozen callers.
 *
 * This mirrors a pattern the repo has already paid for twice: `ZOOM_DIRECT_KEY`
 * / `ZOOM_NANGO_KEY` in `src/lib/zoom/meetings.ts` and `CALENDLY_DIRECT_KEY` /
 * `CALDAV_DIRECT_KEY` in `src/lib/voice-tools/connections.ts`. The difference is
 * that those switches sit in one consuming module each; this one has to serve
 * every email and calendar path, so it is centralized instead.
 *
 * ## Two entry points, deliberately
 *
 * `workspaceProxyForBusiness` THROWS on any non-2xx. That is fidelity to what
 * callers already experience: `nango.proxy()` returns an axios response from an
 * instance created with no `validateStatus` override, so axios's default applies
 * and rejects on anything outside 2xx. Most callers only want "did this work",
 * and the throw is what keeps a send Gmail refused from being reported as a
 * success, or a 500 from an email poll being read as "no new mail".
 *
 * `workspaceProxyStatusForBusiness` returns `{ status, data }` for a provider
 * ERROR response, so a caller that must tell a 403 (scope revoked, reconnect)
 * from a 429 (back off) from a 404 (fall through to a scan) can branch on it. A
 * transport failure carrying no response still throws, because there is no
 * status to report and inventing one would be worse than propagating.
 *
 * Both live here rather than only on the Nango transport so that a first-party
 * Google transport inherits the same distinction for free. PR #1282 established
 * the split on the Nango side and anticipated exactly this: its status
 * normalizer is duck-typed rather than `axios.isAxiosError` specifically so a
 * non-axios client can satisfy the contract.
 *
 * A `null` return keeps its existing, narrower meaning: this business has no
 * such connection, so callers surface `email_not_connected` rather than an
 * error. Once a first-party transport lands, `null` also covers "the connection
 * exists but its token is unusable", which is the same thing from the caller's
 * point of view.
 */
import { nangoProxyForBusiness, nangoProxyStatusForBusiness } from "@/lib/nango/workspace";
import { getWorkspaceOAuthConnectionByNangoIds } from "@/lib/db/workspace-oauth-connections";
import { providerFromKey } from "@/lib/voice-tools/connections";
import { getMicrosoftAccessToken } from "@/lib/microsoft/client";
import { GRAPH_API_BASE_URL } from "@/lib/microsoft/oauth";
import { directProviderRequest } from "./direct-transport";
import { logger } from "@/lib/logger";
import type { WorkspaceLink, WorkspaceProxyArgs, WorkspaceProxyResponse } from "./types";

export type { WorkspaceLink, WorkspaceProxyArgs, WorkspaceProxyResponse } from "./types";

/**
 * Where each first-party provider's API lives, and how to get a live token for
 * it. Adding Google-direct later is one entry here plus its own oauth/client
 * pair: no resolver, cap, cleanup, or call-site change.
 */
type DirectClient = {
  baseUrl: string;
  getAccessToken(connectionRowId: string): Promise<string | null>;
};

const DIRECT_CLIENTS: Partial<Record<"google" | "microsoft", DirectClient>> = {
  microsoft: {
    baseUrl: GRAPH_API_BASE_URL,
    getAccessToken: getMicrosoftAccessToken
  }
};

/**
 * Which transport serves this connection.
 *
 * The row's `transport` column decides, not the provider key: an Outlook
 * mailbox is `provider_config_key = 'outlook'` whether Nango brokers it or we
 * hold the tokens, which is what keeps every resolver and every AiFlow mailbox
 * binding transport-blind.
 *
 * Returns `null` for "no usable connection", which the callers already
 * understand: no row for this business, a direct row whose grant is dead, or a
 * direct row for a provider that has no first-party client yet.
 */
async function directProxy(
  businessId: string,
  link: WorkspaceLink,
  config: WorkspaceProxyArgs
): Promise<{ handled: false } | { handled: true; res: WorkspaceProxyResponse | null }> {
  const row = await getWorkspaceOAuthConnectionByNangoIds(
    businessId,
    link.providerConfigKey,
    link.connectionId
  );
  // No row at all is the Nango transport's answer to give (it re-verifies and
  // returns null itself), so fall through rather than duplicating that here.
  //
  // That fall-through means a NANGO call reads the row twice: once here to
  // learn the transport, once inside nangoProxyForBusiness to verify it. That
  // is a deliberate trade, not an oversight. Reading it once would mean either
  // teaching the Nango transport to accept a pre-verified row (weakening the
  // check that keeps one tenant from reaching another's connection by guessing
  // ids) or inlining the Nango call here (collapsing the layering this module
  // exists to provide). Both are worse than one extra point lookup on a unique
  // index, and the cost sits on the SHRINKING path: as providers move to
  // first-party OAuth, fewer calls take it.
  if (!row || row.transport !== "direct") return { handled: false };

  const provider = providerFromKey(row.provider_config_key);
  const client = DIRECT_CLIENTS[provider];
  if (!client) {
    // A direct row for a provider with no client is a data problem, not a
    // request problem. Degrade to "not connected" rather than throwing an
    // error every caller would have to special-case, and say so in the log.
    logger.warn("direct workspace connection has no client for provider", {
      provider,
      providerConfigKey: row.provider_config_key
    });
    return { handled: true, res: null };
  }

  const accessToken = await client.getAccessToken(row.id);
  // A dead grant (the token manager already deactivated the row) is the direct
  // analogue of having no connection at all.
  if (!accessToken) return { handled: true, res: null };

  return {
    handled: true,
    res: await directProviderRequest(client.baseUrl, accessToken, {
      endpoint: config.endpoint,
      method: config.method,
      data: config.data,
      params: config.params,
      headers: config.headers
    })
  };
}

/**
 * Calls a provider API on behalf of one connected workspace account.
 *
 * `link` must match a row in `workspace_oauth_connections` for `businessId`;
 * the transport re-verifies that before spending a token, so a caller cannot
 * reach another tenant's connection by guessing ids.
 *
 * Returns `null` when no such connection exists for this business. Throws when
 * the provider rejects the request.
 */
export async function workspaceProxyForBusiness(
  businessId: string,
  link: WorkspaceLink,
  config: WorkspaceProxyArgs
): Promise<WorkspaceProxyResponse | null> {
  const direct = await directProxy(businessId, link, config);
  if (direct.handled) return direct.res;

  const res = await nangoProxyForBusiness(businessId, link, config);
  if (!res) return null;
  return { status: res.status, data: res.data };
}

/**
 * Same request as `workspaceProxyForBusiness`, but a provider ERROR response
 * comes back as `{ status, data }` instead of throwing, for callers that branch
 * on the code. A transport failure with no response still throws.
 *
 * Use this only where the status actually changes what the caller does. Reaching
 * for it by default would let a failure be mistaken for an empty success, which
 * is the trap `src/lib/email/organize.ts` documents at its two remaining
 * raw-proxy call sites.
 */
export async function workspaceProxyStatusForBusiness(
  businessId: string,
  link: WorkspaceLink,
  config: WorkspaceProxyArgs
): Promise<WorkspaceProxyResponse | null> {
  // The direct transport needs the same treatment, or a caller that branches on
  // 403-means-reconnect would start seeing throws the moment a tenant moves off
  // Nango. `DirectTransportError` carries the axios-shaped `response` on
  // purpose so both arms normalize identically.
  let direct;
  try {
    direct = await directProxy(businessId, link, config);
  } catch (err) {
    const normalized = directErrorResponse(err);
    if (!normalized) throw err;
    return normalized;
  }
  if (direct.handled) return direct.res;

  return nangoProxyStatusForBusiness(businessId, link, config);
}

/**
 * Reads the HTTP status off a rejected DIRECT call, or undefined when the
 * failure carried no response at all (DNS, timeout, socket reset), which still
 * has to propagate: there is no status to report and inventing one would be
 * worse.
 */
function directErrorResponse(err: unknown): WorkspaceProxyResponse | undefined {
  if (!err || typeof err !== "object") return undefined;
  const response = (err as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const { status, data } = response as { status?: unknown; data?: unknown };
  if (typeof status !== "number" || !Number.isFinite(status)) return undefined;
  if (status < 100 || status > 599) return undefined;
  return { status, data };
}
