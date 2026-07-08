import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlows } from "@/lib/ai-flows/db";
import { listApiKeys } from "@/lib/db/api-keys";
import { listSystemLogs } from "@/lib/db/system-logs";
import { Card } from "@/components/ui/Card";
import { MetaLeadsGuide } from "@/components/dashboard/MetaLeadsGuide";

export const dynamic = "force-dynamic";

/**
 * How-To: capture Meta (Facebook/Instagram) ad leads.
 *
 * A personalized, non-technical walkthrough: install the starter webhook
 * flow, mint an API key, point a Zapier/Make bridge at the tenant's
 * flow-events endpoint, and watch the test lead arrive live (the "recent
 * events" readout below reads webhook_event_received system logs).
 */
export default async function MetaLeadsGuidePage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/guides/meta-leads");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_aiflows");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;
  const businessName = (businesses?.[0]?.name as string | null | undefined) ?? null;

  const [flows, apiKeys, recentLogs] = businessId
    ? await Promise.all([
        listAiFlows(businessId),
        listApiKeys(businessId),
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
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">
            Capture Meta ad leads with your AI coworker
          </h1>
          <p className="mt-1 text-sm text-parchment/50">
            Connect your Facebook/Instagram lead ads so your coworker hears about every new
            lead in real time — and texts them back, files them, and fills you in, on your
            behalf.
          </p>
        </div>
        <Link
          href="/dashboard/aiflows"
          className="shrink-0 whitespace-nowrap text-sm text-signal-teal hover:underline"
        >
          ← Back to AiFlows
        </Link>
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            Provision your coworker first to set up lead capture.
          </p>
          <a href="/onboard" className="block text-center text-sm text-signal-teal hover:underline">
            Get started →
          </a>
        </Card>
      ) : (
        <MetaLeadsGuide
          businessId={businessId}
          businessName={businessName}
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
