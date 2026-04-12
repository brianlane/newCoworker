import { listBusinesses } from "@/lib/db/businesses";
import { checkEnv, getEnvDisplayValue } from "@/lib/admin/system";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

type EnvGroup = {
  label: string;
  vars: { name: string; description: string; key: string }[];
};

const ENV_GROUPS: EnvGroup[] = [
  {
    label: "Supabase",
    vars: [
      { name: "URL", description: "Project URL", key: "NEXT_PUBLIC_SUPABASE_URL" },
      { name: "Anon Key", description: "Public anon key", key: "NEXT_PUBLIC_SUPABASE_ANON_KEY" },
      { name: "Service Role Key", description: "Server-side service key", key: "SUPABASE_SERVICE_ROLE_KEY" }
    ]
  },
  {
    label: "Stripe",
    vars: [
      { name: "Secret Key", description: "API secret key", key: "STRIPE_SECRET_KEY" },
      { name: "Webhook Secret", description: "Webhook signing secret", key: "STRIPE_WEBHOOK_SECRET" },
      { name: "Starter Price ID", description: "Starter plan price", key: "STRIPE_STARTER_PRICE_ID" },
      { name: "Standard Price ID", description: "Standard plan price", key: "STRIPE_STANDARD_PRICE_ID" }
    ]
  },
  {
    label: "Hostinger",
    vars: [
      { name: "API Token", description: "VPS management token", key: "HOSTINGER_API_TOKEN" }
    ]
  },
  {
    label: "Inworld",
    vars: [
      { name: "API Key", description: "Agent platform key", key: "INWORLD_API_KEY" },
      { name: "Workspace", description: "Inworld workspace ID", key: "INWORLD_WORKSPACE" }
    ]
  },
  {
    label: "Twilio",
    vars: [
      { name: "Account SID", description: "Account identifier", key: "TWILIO_ACCOUNT_SID" },
      { name: "Auth Token", description: "Auth token", key: "TWILIO_AUTH_TOKEN" },
      { name: "Phone Number", description: "Outbound number", key: "TWILIO_PHONE_NUMBER" }
    ]
  },
  {
    label: "Email",
    vars: [
      { name: "SMTP Host", description: "Mail server host", key: "SMTP_HOST" },
      { name: "SMTP User", description: "Mail server user", key: "SMTP_USER" },
      { name: "SMTP Pass", description: "Mail server password", key: "SMTP_PASS" }
    ]
  },
  {
    label: "App",
    vars: [
      { name: "App URL", description: "Public app URL", key: "NEXT_PUBLIC_APP_URL" },
      { name: "Admin Email", description: "Admin account email", key: "ADMIN_EMAIL" },
      { name: "OpenAI API Key", description: "LLM key for onboarding chat", key: "OPENAI_API_KEY" }
    ]
  },
  {
    label: "Workspace OAuth",
    vars: [
      { name: "Secret key", description: "Backend secret for workspace (email/calendar) connections", key: "NANGO_SECRET_KEY" },
      { name: "API host", description: "Optional integration API host override", key: "NANGO_HOST" },
      { name: "Public API host", description: "Browser connect flow API URL", key: "NEXT_PUBLIC_NANGO_API_HOST" }
    ]
  },
  {
    label: "Microsoft (stubbed)",
    vars: [
      { name: "Client ID", description: "Azure / Entra app client", key: "MICROSOFT_CLIENT_ID" },
      { name: "Client Secret", description: "Azure / Entra secret", key: "MICROSOFT_CLIENT_SECRET" }
    ]
  },
  {
    label: "Slack (stubbed)",
    vars: [
      { name: "Client ID", description: "Slack app client", key: "SLACK_CLIENT_ID" },
      { name: "Client Secret", description: "Slack app secret", key: "SLACK_CLIENT_SECRET" }
    ]
  }
];

export default async function SystemPage() {
  const businesses = await listBusinesses();

  const totalConfigured = ENV_GROUPS.flatMap((g) => g.vars).filter((v) => checkEnv(v.key)).length;
  const totalVars = ENV_GROUPS.flatMap((g) => g.vars).length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">System</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Environment configuration and service health.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Total Clients</p>
          <p className="text-3xl font-bold text-parchment">{businesses.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Online</p>
          <p className="text-3xl font-bold text-claw-green">
            {businesses.filter((b) => b.status === "online").length}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Env Vars</p>
          <p className="text-3xl font-bold text-parchment">
            {totalConfigured}
            <span className="text-sm text-parchment/40 font-normal">/{totalVars}</span>
          </p>
        </Card>
      </div>

      {/* Environment variables */}
      <div className="space-y-4">
        {ENV_GROUPS.map((group) => {
          const allSet = group.vars.every((v) => checkEnv(v.key));
          const someSet = group.vars.some((v) => checkEnv(v.key));
          return (
            <Card key={group.label}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-parchment">{group.label}</h2>
                <Badge variant={allSet ? "success" : someSet ? "pending" : "error"}>
                  {allSet ? "configured" : someSet ? "partial" : "missing"}
                </Badge>
              </div>
              <div className="space-y-2">
                {group.vars.map((v) => {
                  const configured = checkEnv(v.key);
                  return (
                    <div key={v.key} className="flex items-center justify-between text-sm">
                      <div>
                        <span className="text-parchment/80">{v.name}</span>
                        <span className="text-parchment/30 text-xs ml-2">{v.description}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-parchment/30">
                          {getEnvDisplayValue(configured)}
                        </span>
                        <Badge variant={configured ? "success" : "error"}>
                          {configured ? "✓" : "✗"}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
