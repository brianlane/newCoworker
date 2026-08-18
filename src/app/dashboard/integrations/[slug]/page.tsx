import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";
import { GoogleConnectButton } from "@/components/dashboard/GoogleConnectButton";
import { MicrosoftConnectButton } from "@/components/dashboard/MicrosoftConnectButton";
import { NangoEmailIntegrationActions } from "@/components/dashboard/NangoEmailIntegrationActions";
import { WorkspaceConnectionList } from "@/components/dashboard/WorkspaceConnectionList";
import { CustomIntegrationsCard } from "@/components/dashboard/CustomIntegrationsCard";
import { VagaroIntegrationCard } from "@/components/dashboard/VagaroIntegrationCard";
import { AcuityIntegrationCard } from "@/components/dashboard/AcuityIntegrationCard";
import { CalendlyIntegrationCard } from "@/components/dashboard/CalendlyIntegrationCard";
import { CaldavIntegrationCard } from "@/components/dashboard/CaldavIntegrationCard";
import { MetaIntegrationCard } from "@/components/dashboard/MetaIntegrationCard";
import { WhatsAppIntegrationCard } from "@/components/dashboard/WhatsAppIntegrationCard";
import { GoogleMeetToggle } from "@/components/dashboard/GoogleMeetToggle";
import { ZoomIntegrationCard } from "@/components/dashboard/ZoomIntegrationCard";
import { SlackIntegrationCard } from "@/components/dashboard/SlackIntegrationCard";
import { ZapierApiKeysCard } from "@/components/dashboard/ZapierApiKeysCard";
import { McpConnectorCard } from "@/components/dashboard/McpConnectorCard";
import { MCP_ROUTES } from "@/lib/mcp/routes";
import { isMcpConnectorStale } from "@/lib/mcp/connector-status";
import { findAuthUserEmailById } from "@/lib/auth";
import {
  loadIntegrationsContext,
  type IntegrationsContext
} from "@/lib/dashboard/integrations-context";
import { getIntegration, type IntegrationSlug } from "@/lib/integrations/registry";
import {
  groupByWorkspaceFamily,
  type WorkspaceFamily
} from "@/lib/integrations/workspace-families";
import { GOOGLE_KEYS, OUTLOOK_KEYS } from "@/lib/workspace/reconnect";

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<{ error?: string; workspace?: string; meta?: string }>;

/**
 * The rows one workspace tile owns, in the shape its client components take.
 *
 * Every tile reads the SAME loaded list and filters it here rather than
 * issuing its own query: the plan cap counts one shared pool, so the three
 * pages have to be looking at one snapshot of it.
 */
function workspaceRowsFor(ctx: IntegrationsContext, family: WorkspaceFamily) {
  const grouped = groupByWorkspaceFamily(ctx.workspaceConnections, (r) => r.provider_config_key);
  return grouped[family].map((r) => ({
    id: r.id,
    providerConfigKey: r.provider_config_key,
    connectionId: r.connection_id,
    createdAt: r.created_at,
    metadata: r.metadata
  }));
}

function workspaceCap(ctx: IntegrationsContext) {
  return { used: ctx.workspaceConnectionCap.used, max: ctx.workspaceConnectionCap.max };
}

function IntegrationBody({
  slug,
  businessId,
  ctx,
  mcpConnectedByEmail
}: {
  slug: IntegrationSlug;
  businessId: string;
  ctx: IntegrationsContext;
  /** Who on the team the connector card should name; null when unresolved. */
  mcpConnectedByEmail: string | null;
}) {
  switch (slug) {
    case "google": {
      const rows = workspaceRowsFor(ctx, "google");
      // Mirrors the connect route exactly: at the cap is not enough, because a
      // reconnect consumes no seat. Any Google-family key counts, since the
      // Nango era left four of them and a tenant on `google-mail` reconnects
      // onto their existing row just like one on `google`. Matched against the
      // route's own key list rather than the displayed rows, same as Outlook
      // below. Computed ONCE so the button and the cap copy beneath it cannot
      // contradict each other.
      const blocked =
        ctx.workspaceConnectionCap.atCap &&
        !ctx.workspaceConnections.some((r) =>
          (GOOGLE_KEYS as readonly string[]).includes(r.provider_config_key)
        );
      return (
        <IntegrationCard
          title="Google"
          description="Gmail and Google Calendar, including a personal Google account."
          icon={getIntegration("google")!.icon}
          status={rows.length > 0 ? "connected" : "disconnected"}
        >
          <div className="space-y-3">
            <GoogleConnectButton businessId={businessId} blocked={blocked} />
            <WorkspaceConnectionList
              businessId={businessId}
              connections={rows}
              cap={workspaceCap(ctx)}
              connectBlocked={blocked}
            />
            {/* Only with a Google account on file: Meet rides that grant, so
                the switch has nothing to act on before one exists. */}
            {rows.length > 0 ? (
              <GoogleMeetToggle
                businessId={businessId}
                initialEnabled={ctx.googleMeetEnabled}
              />
            ) : null}
          </div>
        </IntegrationCard>
      );
    }
    case "microsoft": {
      const rows = workspaceRowsFor(ctx, "microsoft");
      // Same reasoning as Google: at the cap is not enough, because a reconnect
      // consumes no seat. An at-cap tenant holding an Outlook row is precisely
      // who needs this button, to migrate off Nango.
      //
      // Matched against OUTLOOK_KEYS, not against the rows this tile DISPLAYS.
      // The tile also shows legacy `outlook-calendar` rows, but the connect
      // route will not reconnect onto one, so counting it here would enable a
      // button the server then refuses.
      const blocked =
        ctx.workspaceConnectionCap.atCap &&
        !ctx.workspaceConnections.some((r) =>
          (OUTLOOK_KEYS as readonly string[]).includes(r.provider_config_key)
        );
      return (
        <IntegrationCard
          title="Microsoft 365"
          description="Outlook mail and calendar, on Microsoft 365 or a personal Outlook account."
          icon={getIntegration("microsoft")!.icon}
          status={rows.length > 0 ? "connected" : "disconnected"}
        >
          <div className="space-y-3">
            <MicrosoftConnectButton businessId={businessId} blocked={blocked} />
            <WorkspaceConnectionList
              businessId={businessId}
              connections={rows}
              cap={workspaceCap(ctx)}
              connectBlocked={blocked}
            />
          </div>
        </IntegrationCard>
      );
    }
    case "workspace": {
      const rows = workspaceRowsFor(ctx, "other");
      return (
        <IntegrationCard
          title="Other 3rd Party Connections"
          description="OneDrive, 1Password, and the rest of the long tail connections set up here through Nango. Google and Microsoft 365 have their own pages, and so do Slack and Zoom."
          icon={getIntegration("workspace")!.icon}
          status={rows.length > 0 ? "connected" : "disconnected"}
        >
          <NangoEmailIntegrationActions
            businessId={businessId}
            connections={rows}
            cap={workspaceCap(ctx)}
          />
        </IntegrationCard>
      );
    }
    case "vagaro":
      return (
        <VagaroIntegrationCard businessId={businessId} initialConnection={ctx.vagaroConnection} />
      );
    case "acuity":
      return (
        <AcuityIntegrationCard businessId={businessId} initialConnection={ctx.acuityConnection} />
      );
    case "calendly":
      return (
        <CalendlyIntegrationCard
          businessId={businessId}
          initialConnections={ctx.calendlyConnections}
        />
      );
    case "caldav":
      return (
        <CaldavIntegrationCard businessId={businessId} initialConnection={ctx.caldavConnection} />
      );
    case "meta":
      return (
        <MetaIntegrationCard businessId={businessId} initialConnection={ctx.metaConnection} />
      );
    case "whatsapp":
      return (
        <WhatsAppIntegrationCard
          businessId={businessId}
          initialConnection={ctx.whatsappConnection}
          metaAppId={process.env.META_APP_ID ?? null}
          configId={process.env.META_WHATSAPP_CONFIG_ID ?? null}
        />
      );
    case "zoom":
      return (
        <ZoomIntegrationCard businessId={businessId} initialConnection={ctx.zoomConnection} />
      );
    case "slack":
      return (
        <SlackIntegrationCard
          businessId={businessId}
          initialConnection={ctx.slackConnection}
          tierAllowed={ctx.slackEnabled}
        />
      );
    case "custom":
      return (
        <CustomIntegrationsCard
          businessId={businessId}
          initialIntegrations={ctx.customIntegrations}
        />
      );
    case "zapier-api":
      return (
        <ZapierApiKeysCard
          businessId={businessId}
          initialKeys={ctx.apiKeys.map((k) => ({
            id: k.id,
            name: k.name,
            key_prefix: k.key_prefix,
            created_at: k.created_at,
            last_used_at: k.last_used_at
          }))}
          activeHooks={ctx.activeHooks.map((h) => ({
            id: h.id,
            event: h.event,
            target_url: h.target_url,
            created_at: h.created_at
          }))}
          webhooksEnabled={ctx.webhooksEnabled}
        />
      );
    case "claude":
    case "chatgpt": {
      const status = ctx.mcpConnectorStatuses[slug];
      return (
        <McpConnectorCard
          client={slug}
          businessId={businessId}
          mcpUrl={`${(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${MCP_ROUTES[slug]}`}
          status={
            status
              ? {
                  firstConnectedAt: status.firstConnectedAt,
                  lastSeenAt: status.lastSeenAt,
                  stale: isMcpConnectorStale(status.lastSeenAt),
                  connectedByEmail: mcpConnectedByEmail
                }
              : null
          }
        />
      );
    }
  }
}

export default async function IntegrationDetailPage({
  params,
  searchParams
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) notFound();

  const q = await searchParams;
  const ctx = await loadIntegrationsContext(`/dashboard/integrations/${integration.slug}`);
  if (!ctx.businessId || (integration.ownerOnly && !ctx.canManageApiKeys)) {
    // Forward the OAuth-callback banner params so the hub still shows the
    // error/success message instead of silently dropping it.
    const forwarded = new URLSearchParams();
    if (q.error) forwarded.set("error", q.error);
    if (q.workspace) forwarded.set("workspace", q.workspace);
    if (q.meta) forwarded.set("meta", q.meta);
    const qs = forwarded.toString();
    redirect(`/dashboard/integrations${qs ? `?${qs}` : ""}`);
  }

  const Icon = integration.icon;

  // Only the two connector pages name a teammate, and only when a row exists,
  // so the auth lookup stays off every other detail page and off the hub.
  const mcpStatus =
    integration.slug === "claude" || integration.slug === "chatgpt"
      ? ctx.mcpConnectorStatuses[integration.slug]
      : null;
  const mcpConnectedByEmail = mcpStatus ? await findAuthUserEmailById(mcpStatus.userId) : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link
          href="/dashboard/integrations"
          className="inline-flex items-center gap-1.5 text-xs text-parchment/50 transition-colors hover:text-parchment"
        >
          <ArrowLeft size={14} />
          All integrations
        </Link>
        <div className="mt-4 flex items-center gap-3">
          <div className="shrink-0 rounded-lg bg-parchment/10 p-2.5 text-signal-teal">
            <Icon size={24} />
          </div>
          <h1 className="text-2xl font-bold text-parchment">{integration.name}</h1>
        </div>
      </div>

      {q.error && (
        <Card className="border-spark-orange/40 bg-spark-orange/5">
          <p className="text-sm text-spark-orange">
            Connection failed: {decodeURIComponent(q.error).replace(/\+/g, " ")}
          </p>
        </Card>
      )}

      {/* Generic success banner: the Google, Outlook, and Zoom callbacks all
          land with workspace=connected on their own detail page. The Nango
          flow lands on the hub instead, because the Connect UI can broker a
          grant that belongs to one of the other tiles. */}
      {q.workspace === "connected" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">Connected successfully.</p>
        </Card>
      )}

      {q.meta === "connected" && integration.slug === "meta" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">
            Facebook connected. Pick the Page to watch for leads below.
          </p>
        </Card>
      )}

      <IntegrationBody
        slug={integration.slug}
        businessId={ctx.businessId}
        ctx={ctx}
        mcpConnectedByEmail={mcpConnectedByEmail}
      />
    </div>
  );
}
