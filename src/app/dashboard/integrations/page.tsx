import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { Card } from "@/components/ui/Card";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";
import { NangoEmailIntegrationActions } from "@/components/dashboard/NangoEmailIntegrationActions";
import { Inbox, MessageSquare, Video, Phone, Wrench } from "lucide-react";
import { Button } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ error?: string; workspace?: string }>;

export default async function IntegrationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/integrations");
  if (!user.email) redirect("/login");

  const q = await searchParams;

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .limit(1);

  const businessId = businesses?.[0]?.id ?? null;

  const workspaceConnections =
    businessId ? await listWorkspaceOAuthConnections(businessId) : [];
  const workspaceConnected = workspaceConnections.length > 0;
  const twilioConfigured = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Integrations</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Connect workspace accounts for email, calendar, and files; add other credentials in Nango as
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <IntegrationCard
                title="Workspace"
                description="Gmail, Google Calendar, Drive, Microsoft 365, and more all in one place using Nango."
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

              <IntegrationCard
                title="Slack"
                description="Workspace messages and alerts (narrow scopes)."
                icon={MessageSquare}
                status="coming_soon"
              >
                <Button type="button" variant="ghost" size="sm" disabled>
                  Connect Slack
                </Button>
              </IntegrationCard>

              <IntegrationCard
                title="Zoom"
                description="Meeting metadata and scheduling helpers."
                icon={Video}
                status="coming_soon"
              >
                <Button type="button" variant="ghost" size="sm" disabled>
                  Connect Zoom
                </Button>
              </IntegrationCard>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
              Platform &amp; custom tools
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <IntegrationCard
                title="Twilio (platform)"
                description="SMS alerts use your workspace&apos;s Twilio configuration."
                icon={Phone}
                status={twilioConfigured ? "platform" : "disconnected"}
                statusLabel={twilioConfigured ? "Configured" : "Not configured"}
              >
                <p className="text-xs text-parchment/45">
                  Managed in environment / provisioning. Contact support to change numbers.
                </p>
              </IntegrationCard>

              <IntegrationCard
                title="Custom tool"
                description="Industry-specific APIs without OAuth — connect via Nango or environment when available."
                icon={Wrench}
                status="coming_soon"
              >
                <Button type="button" variant="ghost" size="sm" disabled>
                  Add API key
                </Button>
              </IntegrationCard>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
