import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlowRuns, listAiFlows } from "@/lib/ai-flows/db";
import { Card } from "@/components/ui/Card";
import { AiFlowRunsManager } from "@/components/dashboard/AiFlowRunsManager";

export const dynamic = "force-dynamic";

export default async function AiFlowRunsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/runs");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  const [runs, flows] = businessId
    ? await Promise.all([
        listAiFlowRuns(businessId, { limit: 100 }),
        listAiFlows(businessId)
      ])
    : [[], []];

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">AiFlow runs</h1>
          <p className="mt-1 text-sm text-parchment/50">
            History of automation runs and approvals.
          </p>
        </div>
        <Link href="/dashboard/aiflows" className="text-sm text-signal-teal hover:underline">
          ← Back to AiFlows
        </Link>
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">No business found.</p>
        </Card>
      ) : (
        <AiFlowRunsManager
          businessId={businessId}
          initialRuns={runs}
          flows={flows.map((f) => ({ id: f.id, name: f.name }))}
        />
      )}
    </div>
  );
}
