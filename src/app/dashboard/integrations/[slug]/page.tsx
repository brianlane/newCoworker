import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";
import { NangoEmailIntegrationActions } from "@/components/dashboard/NangoEmailIntegrationActions";
import { CustomIntegrationsCard } from "@/components/dashboard/CustomIntegrationsCard";
import { VagaroIntegrationCard } from "@/components/dashboard/VagaroIntegrationCard";
import { CalendlyIntegrationCard } from "@/components/dashboard/CalendlyIntegrationCard";
import { CaldavIntegrationCard } from "@/components/dashboard/CaldavIntegrationCard";
import { MetaIntegrationCard } from "@/components/dashboard/MetaIntegrationCard";
import { ZoomIntegrationCard } from "@/components/dashboard/ZoomIntegrationCard";
import { ZapierApiKeysCard } from "@/components/dashboard/ZapierApiKeysCard";
import { ClaudeConnectorCard } from "@/components/dashboard/ClaudeConnectorCard";
import {
  loadIntegrationsContext,
  type IntegrationsContext
} from "@/lib/dashboard/integrations-context";
import { getIntegration, type IntegrationSlug } from "@/lib/integrations/registry";

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<{ error?: string; workspace?: string; meta?: string }>;

function IntegrationBody({
  slug,
  businessId,
  ctx
}: {
  slug: IntegrationSlug;
  businessId: string;
  ctx: IntegrationsContext;
}) {
  switch (slug) {
    case "workspace":
      return (
        <IntegrationCard
          title="Workspace"
          description="Gmail, Google Calendar, Drive, Microsoft 365, Slack, and more; add each integration simply with Nango. Zoom connects from its own integration page."
          icon={getIntegration("workspace")!.icon}
          status={ctx.workspaceConnections.length > 0 ? "connected" : "disconnected"}
        >
          <NangoEmailIntegrationActions
            businessId={businessId}
            connections={ctx.workspaceConnections.map((r) => ({
              id: r.id,
              providerConfigKey: r.provider_config_key,
              connectionId: r.connection_id,
              createdAt: r.created_at,
              metadata: r.metadata
            }))}
          />
        </IntegrationCard>
      );
    case "vagaro":
      return (
        <VagaroIntegrationCard businessId={businessId} initialConnection={ctx.vagaroConnection} />
      );
    case "calendly":
      return (
        <CalendlyIntegrationCard
          businessId={businessId}
          initialConnection={ctx.calendlyConnection}
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
    case "zoom":
      return (
        <ZoomIntegrationCard businessId={businessId} initialConnection={ctx.zoomConnection} />
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
        />
      );
    case "claude":
      return (
        <ClaudeConnectorCard
          mcpUrl={`${(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/mcp`}
        />
      );
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

      {/* Generic success banner — the Nango and Zoom flows both land with
          workspace=connected on their own detail page. */}
      {q.workspace === "connected" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">Connected successfully.</p>
        </Card>
      )}

      {q.meta === "connected" && integration.slug === "meta" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">
            Facebook connected — pick the Page to watch for leads below.
          </p>
        </Card>
      )}

      <IntegrationBody slug={integration.slug} businessId={ctx.businessId} ctx={ctx} />
    </div>
  );
}
