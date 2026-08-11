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
import type { WorkspaceLink, WorkspaceProxyArgs, WorkspaceProxyResponse } from "./types";

export type { WorkspaceLink, WorkspaceProxyArgs, WorkspaceProxyResponse } from "./types";

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
  return nangoProxyStatusForBusiness(businessId, link, config);
}
