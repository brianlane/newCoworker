import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getIntegration } from "@/lib/db/integrations";
import { Card } from "@/components/ui/Card";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";
import { GoogleIntegrationActions } from "@/components/dashboard/GoogleIntegrationActions";
import { CrmApiKeyStub } from "@/components/dashboard/CrmApiKeyStub";
import {
  Mail,
  Calendar,
  MessageSquare,
  Video,
  Building2,
  Phone,
  Wrench
} from "lucide-react";
import { Button } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ error?: string; google?: string }>;

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

  const googleIntegration =
    businessId ? await getIntegration(businessId, "google") : null;
  const googleConnected =
    googleIntegration?.status === "connected" && !!googleIntegration?.access_token;

  const twilioConfigured = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Integrations</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Connect OAuth accounts and manage API credentials for your AI coworker
        </p>
      </div>

      {q.error && (
        <Card className="border-spark-orange/40 bg-spark-orange/5">
          <p className="text-sm text-spark-orange">
            Google connection failed: {decodeURIComponent(q.error).replace(/\+/g, " ")}
          </p>
        </Card>
      )}

      {q.google === "connected" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">Google Workspace connected successfully.</p>
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
                title="Google Workspace"
                description="Gmail, Google Calendar, and Drive (read-only) for your coworker."
                icon={Mail}
                status={googleConnected ? "connected" : "disconnected"}
              >
                <GoogleIntegrationActions
                  businessId={businessId}
                  initiallyConnected={googleConnected}
                />
              </IntegrationCard>

              <IntegrationCard
                title="Microsoft Outlook"
                description="Email and calendar via Microsoft Entra ID — same pattern as Google."
                icon={Calendar}
                status="coming_soon"
              >
                <Button type="button" variant="ghost" size="sm" disabled>
                  Connect Outlook
                </Button>
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
              API key vault
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <IntegrationCard
                title="CRM API key"
                description="Salesforce, HubSpot, or custom CRM — encrypted at rest, pushed to your VPS."
                icon={Building2}
                status="coming_soon"
                statusLabel="Vault (stub)"
              >
                <CrmApiKeyStub />
              </IntegrationCard>

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
                description="Industry-specific APIs without OAuth — stored in the vault."
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
