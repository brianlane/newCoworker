import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { LeadBacklogImport } from "@/components/dashboard/LeadBacklogImport";

export const dynamic = "force-dynamic";

/**
 * Import a lead backlog — its own page (linked from the AiFlows header).
 *
 * The import is a one-off event the owner RUNS (upload a sheet, fire the
 * webhook flows), not a setting that belongs on the AiFlows list, so it gets
 * a dedicated page instead of a card at the bottom of the builder.
 */
export default async function ImportLeadsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/import-leads");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_aiflows");
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">Import leads</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Upload an Excel or CSV backlog of leads and run an AiFlow on each row — pick
            one flow, or let rows trigger-match your webhook-triggered flows the same way
            a live Zapier/Make lead arrives.
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
            Provision your coworker first to import leads.
          </p>
          <a href="/onboard" className="block text-center text-sm text-signal-teal hover:underline">
            Get started →
          </a>
        </Card>
      ) : (
        <LeadBacklogImport businessId={businessId} />
      )}
    </div>
  );
}
