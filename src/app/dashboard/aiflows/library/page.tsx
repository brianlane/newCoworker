import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlowLibrary } from "@/lib/ai-flows/library";
import { Card } from "@/components/ui/Card";
import { AiFlowLibraryBrowser } from "@/components/dashboard/AiFlowLibraryBrowser";

export const dynamic = "force-dynamic";

export default async function AiFlowLibraryPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/library");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_aiflows");
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  const entries = await listAiFlowLibrary();

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">AiFlow library</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Popular automations other businesses run successfully.
          </p>
        </div>
        <Link
          href="/dashboard/aiflows"
          className="text-sm text-signal-teal hover:underline sm:shrink-0 sm:whitespace-nowrap"
        >
          ← Back to AiFlows
        </Link>
      </div>

      {entries.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            No published flows yet. Once automations start running successfully, the most
            popular ones show up here.
          </p>
        </Card>
      ) : (
        <AiFlowLibraryBrowser businessId={businessId} entries={entries} />
      )}
    </div>
  );
}
