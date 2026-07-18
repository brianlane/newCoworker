import { redirect } from "next/navigation";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { can } from "@/lib/authz/policy";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlows } from "@/lib/ai-flows/db";
import { listApiKeys } from "@/lib/db/api-keys";
import { listSystemLogs } from "@/lib/db/system-logs";
import { Card } from "@/components/ui/Card";
import { InstagramLeadsGuide } from "@/components/dashboard/InstagramLeadsGuide";

export const dynamic = "force-dynamic";

/**
 * How-To: turn Instagram prospect lists into reviewed contacts.
 *
 * A personalized, non-technical walkthrough for owner-operated scraping
 * tools (Apify, PhantomBuster, IGLeads, …): install the no-outreach starter
 * webhook flow, then either import the tool's CSV export on the lead-backlog
 * page or wire a live Make.com/Zapier bridge at the tenant's flow-events
 * endpoint — and watch the test prospects arrive live (the "recent events"
 * readout below reads webhook_event_received system logs). Mirrors the
 * meta-leads guide page one-for-one in auth and data loading.
 */
export default async function InstagramLeadsGuidePage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/guides/instagram-leads");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const ctx = await resolveActiveBusinessContext(user);
  const activeBusinessId =
    ctx.businessId && ctx.role && can(ctx.role, "manage_aiflows") ? ctx.businessId : null;
  // API keys are a manage_billing (owner) capability — managers get the
  // guide without key metadata (hasApiKey drives copy only).
  const canManageApiKeys = !!ctx.role && can(ctx.role, "manage_billing");
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  const [flows, apiKeys, recentLogs] = businessId
    ? await Promise.all([
        listAiFlows(businessId),
        canManageApiKeys ? listApiKeys(businessId) : Promise.resolve([]),
        listSystemLogs(businessId, {
          source: "aiflow",
          search: "webhook_event_received",
          limit: 5
        })
      ])
    : [[], [], []];

  const webhookFlows = flows
    .filter((f) => f.definition?.trigger?.channel === "webhook")
    .map((f) => ({ id: f.id, name: f.name, enabled: f.enabled }));

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">
            Turn Instagram prospect lists into reviewed contacts
          </h1>
          <p className="mt-1 text-sm text-parchment/50">
            Feed prospects from an Instagram scraping tool (Apify, PhantomBuster, IGLeads, …)
            to your coworker — every one gets filed and tagged for your review, never
            contacted without your say-so.
          </p>
        </div>
        <Link
          href="/dashboard/aiflows"
          className="text-sm text-signal-teal hover:underline sm:shrink-0 sm:whitespace-nowrap"
        >
          ← Back to AiFlows
        </Link>
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            Provision your coworker first to set up prospect intake.
          </p>
          <a href="/onboard" className="block text-center text-sm text-signal-teal hover:underline">
            Get started →
          </a>
        </Card>
      ) : (
        <InstagramLeadsGuide
          businessId={businessId}
          endpointUrl={`${appUrl}/api/public/v1/flow-events`}
          hasApiKey={apiKeys.length > 0}
          webhookFlows={webhookFlows}
          recentEvents={recentLogs.map((l) => ({
            id: l.id,
            createdAt: l.created_at,
            source: String(l.payload?.source_label ?? "webhook"),
            runsEnqueued: Number(l.payload?.runs_enqueued ?? 0),
            // Older rows predate flows_matched; fall back to runs_enqueued so
            // a past successful delivery never renders as "no flow matched".
            flowsMatched: Number(l.payload?.flows_matched ?? l.payload?.runs_enqueued ?? 0),
            preview: String(l.payload?.preview ?? "").slice(0, 200)
          }))}
        />
      )}
    </div>
  );
}
