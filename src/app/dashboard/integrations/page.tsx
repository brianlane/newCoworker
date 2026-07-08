import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { listCustomIntegrations } from "@/lib/db/custom-integrations";
import { listApiKeys } from "@/lib/db/api-keys";
import { listWebhookSubscriptions } from "@/lib/db/webhook-subscriptions";
import { Card } from "@/components/ui/Card";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";
import { NangoEmailIntegrationActions } from "@/components/dashboard/NangoEmailIntegrationActions";
import { CustomIntegrationsCard } from "@/components/dashboard/CustomIntegrationsCard";
import { ZapierApiKeysCard } from "@/components/dashboard/ZapierApiKeysCard";
import { Inbox } from "lucide-react";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ error?: string; workspace?: string }>;

export default async function IntegrationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/integrations");
  if (!user.email) redirect("/login");

  const q = await searchParams;

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const businessId = businesses?.[0]?.id ?? null;

  const workspaceConnections =
    businessId ? await listWorkspaceOAuthConnections(businessId) : [];
  const workspaceConnected = workspaceConnections.length > 0;
  const customIntegrations =
    businessId ? await listCustomIntegrations(businessId) : [];
  const apiKeys = businessId ? await listApiKeys(businessId) : [];
  const activeHooks = businessId ? await listWebhookSubscriptions(businessId) : [];

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Integrations</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Connect workspace accounts for email, calendar, and files; add other credentials as
          needed.
        </p>
      </div>

      {q.error && (
        <Card className="border-spark-orange/40 bg-spark-orange/5">
          <p className="text-sm text-spark-orange">
            Connection failed: {decodeURIComponent(q.error).replace(/\+/g, " ")}
          </p>
        </Card>
      )}

      {q.workspace === "connected" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">Connected successfully.</p>
        </Card>
      )}

      {!businessId ? (
        <Card>
          <p className="text-parchment/60 text-sm text-center py-6">
            Provision your coworker first to manage integrations.
          </p>
          <a
            href="/onboard"
            className="block text-center text-sm text-signal-teal hover:underline"
          >
            Get started →
          </a>
        </Card>
      ) : (
        <>
          <section className="space-y-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              OAuth connections
            </h2>
            <div className="grid grid-cols-1 gap-4 max-w-xl">
              <IntegrationCard
                title="Workspace"
                description="Gmail, Google Calendar, Drive, Microsoft 365, Slack, Zoom, and more; add each integration simply with Nango."
                icon={Inbox}
                status={workspaceConnected ? "connected" : "disconnected"}
              >
                <NangoEmailIntegrationActions
                  businessId={businessId}
                  connections={workspaceConnections.map((r) => ({
                    id: r.id,
                    providerConfigKey: r.provider_config_key,
                    connectionId: r.connection_id,
                    createdAt: r.created_at,
                    metadata: r.metadata
                  }))}
                />
              </IntegrationCard>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Custom integrations
            </h2>
            <div className="grid grid-cols-1 gap-4 max-w-xl">
              <CustomIntegrationsCard
                businessId={businessId}
                initialIntegrations={customIntegrations}
              />
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Zapier &amp; API
            </h2>
            <div className="grid grid-cols-1 gap-4 max-w-xl">
              <ZapierApiKeysCard
                businessId={businessId}
                initialKeys={apiKeys.map((k) => ({
                  id: k.id,
                  name: k.name,
                  key_prefix: k.key_prefix,
                  created_at: k.created_at,
                  last_used_at: k.last_used_at
                }))}
                activeHooks={activeHooks.map((h) => ({
                  id: h.id,
                  event: h.event,
                  target_url: h.target_url,
                  created_at: h.created_at
                }))}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
