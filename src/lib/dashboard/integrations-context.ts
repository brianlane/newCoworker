/**
 * Shared server-side loader for /dashboard/integrations and its
 * per-integration detail pages (/dashboard/integrations/[slug]).
 *
 * Resolves auth + the active business (manage_settings gate), then loads
 * the connection state for every integration in one place so the hub grid
 * can show per-tile status and each detail page gets the exact props its
 * card component needs, without duplicating the resolution logic.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { can } from "@/lib/authz/policy";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import {
  workspaceConnectionCapState,
  type WorkspaceConnectionCapState
} from "@/lib/nango/connection-cap";
import { listCustomIntegrations } from "@/lib/db/custom-integrations";
import { getPublicVagaroConnection } from "@/lib/db/vagaro-connections";
import { getPublicAcuityConnection } from "@/lib/db/acuity-connections";
import { listPublicCalendlyConnections } from "@/lib/db/calendly-connections";
import { getPublicCaldavConnection } from "@/lib/db/caldav-connections";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getPublicZoomConnection } from "@/lib/db/zoom-connections";
import { getPublicSlackConnection } from "@/lib/db/slack-connections";
import { slackAllowedForTier } from "@/lib/slack/tier-gate";
import { coworkerChannelAllowedForTier } from "@/lib/coworker-channels/tier-gate";
import { getPublicCoworkerConnection } from "@/lib/db/coworker-connections";
import { listApiKeys } from "@/lib/db/api-keys";
import { listWebhookSubscriptions } from "@/lib/db/webhook-subscriptions";
import { webhooksAllowedForTier } from "@/lib/plans/webhooks";
import {
  getMcpConnectorStatusForBusiness,
  isMcpConnectorStale,
  type McpConnectorStatus
} from "@/lib/mcp/connector-status";
import { groupByWorkspaceFamily } from "@/lib/integrations/workspace-families";
import type { IntegrationSlug, IntegrationStatus } from "@/lib/integrations/registry";

export type IntegrationsContext = {
  businessId: string | null;
  /** API keys are a manage_billing (owner) capability. */
  canManageApiKeys: boolean;
  /** False on starter: Zapier/API webhooks are a Standard-tier perk. */
  webhooksEnabled: boolean;
  workspaceConnections: Awaited<ReturnType<typeof listWorkspaceOAuthConnections>>;
  /** Tier cap on Nango workspace connections (max null = unlimited). */
  workspaceConnectionCap: WorkspaceConnectionCapState;
  customIntegrations: Awaited<ReturnType<typeof listCustomIntegrations>>;
  vagaroConnection: Awaited<ReturnType<typeof getPublicVagaroConnection>>;
  acuityConnection: Awaited<ReturnType<typeof getPublicAcuityConnection>>;
  /** ALL direct Calendly connections, oldest (primary) first. */
  calendlyConnections: Awaited<ReturnType<typeof listPublicCalendlyConnections>>;
  caldavConnection: Awaited<ReturnType<typeof getPublicCaldavConnection>>;
  metaConnection: Awaited<ReturnType<typeof getPublicMetaConnection>>;
  whatsappConnection: Awaited<ReturnType<typeof getPublicWhatsAppConnection>>;
  zoomConnection: Awaited<ReturnType<typeof getPublicZoomConnection>>;
  /**
   * Owner opt-in for Google Meet links on bookings. Not a connection: Meet
   * rides the Google Calendar grant this tenant already has, so the Google
   * tile renders this as a switch rather than a Connect button.
   */
  googleMeetEnabled: boolean;
  slackConnection: Awaited<ReturnType<typeof getPublicSlackConnection>>;
  telegramConnection: Awaited<ReturnType<typeof getPublicCoworkerConnection>>;
  /** False on starter: the Slack integration is a Standard-tier perk. */
  slackEnabled: boolean;
  telegramEnabled: boolean;
  apiKeys: Awaited<ReturnType<typeof listApiKeys>>;
  activeHooks: Awaited<ReturnType<typeof listWebhookSubscriptions>>;
  /**
   * THIS BUSINESS's connector status per assistant, from whichever login used
   * it last. Null = no assistant has ever acted on this business, or the
   * best-effort read failed.
   *
   * Business-scoped on purpose. Keying it on the signed-in login meant an
   * admin using view-as saw their own connector painted onto every tenant's
   * tile, and a teammate's real connection showed for nobody but them.
   */
  mcpConnectorStatuses: Record<"claude" | "chatgpt", McpConnectorStatus | null>;
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
  // API keys are a manage_billing (owner) capability: the key routes refuse
  // managers, so don't server-render key metadata into their HTML either.
  const canManageApiKeys = !!ctx.role && can(ctx.role, "manage_billing");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, tier, enterprise_limits, google_meet_enabled")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const businessRow = (businesses?.[0] ?? null) as {
    id: string;
    tier?: string | null;
    enterprise_limits?: unknown;
    google_meet_enabled?: boolean | null;
  } | null;
  const businessId = businessRow?.id ?? null;

  const workspaceConnections = businessId
    ? await listWorkspaceOAuthConnections(businessId)
    : [];

  return {
    businessId,
    canManageApiKeys,
    webhooksEnabled: webhooksAllowedForTier(businessRow?.tier),
    workspaceConnections,
    workspaceConnectionCap: workspaceConnectionCapState(
      businessRow?.tier,
      workspaceConnections.length,
      businessRow?.enterprise_limits ?? undefined
    ),
    customIntegrations: businessId ? await listCustomIntegrations(businessId) : [],
    vagaroConnection: businessId ? await getPublicVagaroConnection(businessId) : null,
    acuityConnection: businessId ? await getPublicAcuityConnection(businessId) : null,
    calendlyConnections: businessId ? await listPublicCalendlyConnections(businessId) : [],
    caldavConnection: businessId ? await getPublicCaldavConnection(businessId) : null,
    metaConnection: businessId ? await getPublicMetaConnection(businessId) : null,
    whatsappConnection: businessId ? await getPublicWhatsAppConnection(businessId) : null,
    zoomConnection: businessId ? await getPublicZoomConnection(businessId) : null,
    googleMeetEnabled: businessRow?.google_meet_enabled === true,
    slackConnection: businessId ? await getPublicSlackConnection(businessId) : null,
    telegramConnection: businessId
      ? await getPublicCoworkerConnection(businessId, "telegram")
      : null,
    slackEnabled: slackAllowedForTier(businessRow?.tier),
    telegramEnabled: coworkerChannelAllowedForTier(businessRow?.tier),
    // Never load key metadata for non-owners: the key routes refuse
    // managers, so don't server-render it into their HTML either.
    apiKeys: businessId && canManageApiKeys ? await listApiKeys(businessId) : [],
    activeHooks: businessId ? await listWebhookSubscriptions(businessId) : [],
    // One read per client, for the ACTIVE BUSINESS. Best-effort: a status-read
    // failure must not take the page down, the card just falls back to the
    // instructions-only state.
    mcpConnectorStatuses: {
      claude: businessId
        ? await getMcpConnectorStatusForBusiness(businessId, "claude").catch(() => null)
        : null,
      chatgpt: businessId
        ? await getMcpConnectorStatusForBusiness(businessId, "chatgpt").catch(() => null)
        : null
    }
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

  const whatsappStatus: IntegrationStatus = !ctx.whatsappConnection
    ? disconnected
    : ctx.whatsappConnection.is_active
      ? connected
      : { state: "attention", label: "Paused" };

  const slackStatus: IntegrationStatus = !ctx.slackConnection
    ? disconnected
    : ctx.slackConnection.is_active && ctx.slackConnection.has_bot_token
      ? connected
      : { state: "attention", label: "Needs reconnect" };

  // Telegram has no separate "has token" flag: an empty credential IS the
  // needs-reconnect state, and the public read deliberately never returns
  // the token itself, so `is_active` is the whole signal here.
  const telegramStatus: IntegrationStatus = !ctx.telegramConnection
    ? disconnected
    : ctx.telegramConnection.is_active
      ? connected
      : { state: "attention", label: "Paused" };

  const customCount = ctx.customIntegrations.length;
  const keyCount = ctx.apiKeys.length;

  // Google, Microsoft 365, and the Nango long tail are three tiles over one
  // table, so each tile counts only the rows it actually shows. Counting the
  // whole table on each would light up all three the moment a tenant connected
  // any one of them.
  const families = groupByWorkspaceFamily(
    ctx.workspaceConnections,
    (r) => r.provider_config_key
  );
  const countStatus = (n: number): IntegrationStatus =>
    n === 0
      ? disconnected
      : { state: "connected", label: n === 1 ? "Connected" : `${n} connected` };

  // Removing a connector inside Claude or ChatGPT tells us nothing, so a long
  // silence is the only signal we get that one is gone. "Gone quiet" rather
  // than "Needs reconnect": a tenant who simply has not asked their coworker
  // for anything this month does not need to reconnect anything.
  const mcpStatus = (status: McpConnectorStatus | null): IntegrationStatus => {
    if (!status) return { state: "disconnected", label: "Available" };
    if (isMcpConnectorStale(status.lastSeenAt)) {
      return { state: "attention", label: "Gone quiet" };
    }
    return connected;
  };

  return {
    google: countStatus(families.google.length),
    microsoft: countStatus(families.microsoft.length),
    workspace: countStatus(families.other.length),
    vagaro: ctx.vagaroConnection ? connected : disconnected,
    acuity: ctx.acuityConnection ? connected : disconnected,
    calendly:
      ctx.calendlyConnections.length > 0
        ? {
            state: "connected",
            label:
              ctx.calendlyConnections.length === 1
                ? "Connected"
                : `${ctx.calendlyConnections.length} accounts connected`
          }
        : disconnected,
    caldav: ctx.caldavConnection ? connected : disconnected,
    meta: metaStatus,
    whatsapp: whatsappStatus,
    zoom: zoomStatus,
    slack: slackStatus,
    telegram: telegramStatus,
    custom:
      customCount > 0
        ? { state: "connected", label: `${customCount} connected` }
        : { state: "disconnected", label: "None yet" },
    "zapier-api":
      keyCount > 0
        ? { state: "connected", label: keyCount === 1 ? "1 key" : `${keyCount} keys` }
        : { state: "disconnected", label: "No keys" },
    // Business-scoped, like every other tile here: connected once an
    // assistant has made an authorized call on THIS business, from any login
    // on the team.
    claude: mcpStatus(ctx.mcpConnectorStatuses.claude),
    chatgpt: mcpStatus(ctx.mcpConnectorStatuses.chatgpt)
  };
}
