/**
 * Absolute dashboard URLs for search and fetch results.
 *
 * OpenAI's `fetch` contract asks for a user-openable URL so ChatGPT can cite
 * a result and the person can click through to the real thing. They must be
 * absolute, so a relative path is no use here.
 *
 * Built from `siteUrl` rather than a literal, because `tests/site-url.test.ts`
 * fails the build if a hardcoded newcoworker.com origin reappears in `src/`,
 * and because the canonical host (www, not the apex) is a decision that lives
 * in one place on purpose.
 */

import { siteUrl } from "@/lib/marketing/site-url";
import type { McpResourceId } from "@/lib/mcp/resource-id";

/**
 * Where a resource lives in the owner's dashboard.
 *
 * Caveat worth knowing rather than hiding: these pages resolve the viewer's
 * ACTIVE business themselves, and none of them accept a business as a query
 * parameter. So for an account that can reach several businesses, a link
 * opens the right record only when the recipient's active business matches.
 * The link is still the right destination; it may just need a business switch
 * first. Encoding a business in the URL would not fix it, since the pages do
 * not read one.
 */
export function mcpDashboardUrl(id: McpResourceId): string {
  const ref = encodeURIComponent(id.ref);
  switch (id.kind) {
    case "contact":
      return siteUrl(`/dashboard/customers/${ref}`);
    case "thread":
      return siteUrl(`/dashboard/messages/${ref}`);
    case "call":
      return siteUrl(`/dashboard/calls/${ref}`);
  }
}
