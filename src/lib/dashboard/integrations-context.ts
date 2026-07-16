/**
 * Shared server-side loader for /dashboard/integrations and its
 * per-integration detail pages (/dashboard/integrations/[slug]).
 *
 * Resolves auth + the active business (manage_settings gate), then loads
 * the connection state for every integration in one place so the hub grid
 * can show per-tile status and each detail page gets the exact props its
 * card component needs — without duplicating the resolution logic.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { can } from "@/lib/authz/policy";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { listCustomIntegrations } from "@/lib/db/custom-integrations";
import { getPublicVagaroConnection } from "@/lib/db/vagaro-connections";
import { getPublicCalendlyConnection } from "@/lib/db/calendly-connections";
import { getPublicCaldavConnection } from "@/lib/db/caldav-connections";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { getPublicZoomConnection } from "@/lib/db/zoom-connections";
import { listApiKeys } from "@/lib/db/api-keys";
import { listWebhookSubscriptions } from "@/lib/db/webhook-subscriptions";
import type { IntegrationSlug, IntegrationStatus } from "@/lib/integrations/registry";

export type IntegrationsContext = {
  businessId: string | null;
  /** API keys are a manage_billing (owner) capability. */
  canManageApiKeys: boolean;
  workspaceConnections: Awaited<ReturnType<typeof listWorkspaceOAuthConnections>>;
  customIntegrations: Awaited<ReturnType<typeof listCustomIntegrations>>;
  vagaroConnection: Awaited<ReturnType<typeof getPublicVagaroConnection>>;
  calendlyConnection: Awaited<ReturnType<typeof getPublicCalendlyConnection>>;
  caldavConnection: Awaited<ReturnType<typeof getPublicCaldavConnection>>;
  metaConnection: Awaited<ReturnType<typeof getPublicMetaConnection>>;
  zoomConnection: Awaited<ReturnType<typeof getPublicZoomConnection>>;
  apiKeys: Awaited<ReturnType<typeof listApiKeys>>;
  activeHooks: Awaited<ReturnType<typeof listWebhookSubscriptions>>;
};

/**
 * Redirects to /login when unauthenticated (`redirectTo` = the page being
 * loaded, so the user lands back where they started).
 */
export async function loadIntegrationsContext(
  redirectTo: string
): Promise<IntegrationsContext> {
  const user = await getAuthUser();
  if (!user) redirect(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const ctx = await resolveActiveBusinessContext(user, db);
  const activeBusinessId =
    ctx.businessId && ctx.role && can(ctx.role, "manage_settings") ? ctx.businessId : null;
  // API keys are a manage_billing (owner) capability — the key routes refuse
  // managers, so don't server-render key metadata into their HTML either.
  const canManageApiKeys = !!ctx.role && can(ctx.role, "manage_billing");
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const businessId = businesses?.[0]?.id ?? null;

  return {
    businessId,
    canManageApiKeys,
    workspaceConnections: businessId ? await listWorkspaceOAuthConnections(businessId) : [],
    customIntegrations: businessId ? await listCustomIntegrations(businessId) : [],
    vagaroConnection: businessId ? await getPublicVagaroConnection(businessId) : null,
    calendlyConnection: businessId ? await getPublicCalendlyConnection(businessId) : null,
    caldavConnection: businessId ? await getPublicCaldavConnection(businessId) : null,
    metaConnection: businessId ? await getPublicMetaConnection(businessId) : null,
    zoomConnection: businessId ? await getPublicZoomConnection(businessId) : null,
    // Never load key metadata for non-owners — the key routes refuse
    // managers, so don't server-render it into their HTML either.
    apiKeys: businessId && canManageApiKeys ? await listApiKeys(businessId) : [],
    activeHooks: businessId ? await listWebhookSubscriptions(businessId) : []
  };
}

/** Per-tile display status for the hub grid, computed from loaded state. */
export function computeIntegrationStatuses(
  ctx: IntegrationsContext
): Record<IntegrationSlug, IntegrationStatus> {
  const connected: IntegrationStatus = { state: "connected", label: "Connected" };
  const disconnected: IntegrationStatus = { state: "disconnected", label: "Not connected" };

  const metaStatus: IntegrationStatus = !ctx.metaConnection
    ? disconnected
    : ctx.metaConnection.status === "active"
      ? connected
      : { state: "attention", label: "Almost there" };

  const zoomStatus: IntegrationStatus = !ctx.zoomConnection
    ? disconnected
    : ctx.zoomConnection.is_active
      ? connected
      : { state: "attention", label: "Needs reconnect" };

  const customCount = ctx.customIntegrations.length;
  const keyCount = ctx.apiKeys.length;

  return {
    workspace:
      ctx.workspaceConnections.length > 0
        ? {
            state: "connected",
            label:
              ctx.workspaceConnections.length === 1
                ? "Connected"
                : `${ctx.workspaceConnections.length} connected`
          }
        : disconnected,
    vagaro: ctx.vagaroConnection ? connected : disconnected,
    calendly: ctx.calendlyConnection ? connected : disconnected,
    caldav: ctx.caldavConnection ? connected : disconnected,
    meta: metaStatus,
    zoom: zoomStatus,
    custom:
      customCount > 0
        ? { state: "connected", label: `${customCount} connected` }
        : { state: "disconnected", label: "None yet" },
    "zapier-api":
      keyCount > 0
        ? { state: "connected", label: keyCount === 1 ? "1 key" : `${keyCount} keys` }
        : { state: "disconnected", label: "No keys" },
    // Purely informational — the connector authenticates with the owner's
    // own login on Claude's side, so there is no stored connection here.
    claude: { state: "disconnected", label: "Available" }
  };
}
