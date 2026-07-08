import { Suspense } from "react";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlowRuns, listAiFlows } from "@/lib/ai-flows/db";
import { resolveContactNames } from "@/lib/db/contact-names";
import { Card } from "@/components/ui/Card";
import { AiFlowRunsManager } from "@/components/dashboard/AiFlowRunsManager";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = { searchParams: Promise<{ flowId?: string }> };

export default async function AiFlowRunsPage({ searchParams }: Props) {
  const { flowId: rawFlowId } = await searchParams;
  // Ignore a malformed flowId rather than letting it reach the query and 500
  // (mirrors the runs API route, which also drops invalid ids).
  const flowId = rawFlowId && UUID_RE.test(rawFlowId) ? rawFlowId : undefined;

  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/runs");
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

  const [runs, flows] = businessId
    ? await Promise.all([
        listAiFlowRuns(businessId, { flowId, limit: 100 }),
        listAiFlows(businessId)
      ])
    : [[], []];

  // Resolve the offered employees' numbers to their roster/contact names so the
  // routing section reads "Offered to Jordan Reyes" instead of a bare E.164.
  const employeeNames = businessId
    ? await resolveContactNames(
        businessId,
        runs.map((r) => r.awaiting_agent_e164).filter((p): p is string => Boolean(p)),
        db
      )
        .then((map) =>
          Object.fromEntries([...map.entries()].map(([e164, c]) => [e164, c.name]))
        )
        .catch(() => ({} as Record<string, string>))
    : ({} as Record<string, string>);

  // When filtered to one flow, title the page after it and offer a way back to
  // that flow's detail view (rather than the whole AiFlows list).
  const filteredFlow = flowId ? flows.find((f) => f.id === flowId) ?? null : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">
            {filteredFlow ? `${filteredFlow.name}: runs` : "AiFlow runs"}
          </h1>
          <p className="mt-1 text-sm text-parchment/50">
            {filteredFlow
              ? "Run history and approvals for this AiFlow."
              : "History of automation runs and approvals."}
          </p>
        </div>
        <Link
          href={filteredFlow ? `/dashboard/aiflows/${filteredFlow.id}` : "/dashboard/aiflows"}
          className="text-sm text-signal-teal hover:underline"
        >
          {filteredFlow ? "← Back to AiFlow" : "← Back to AiFlows"}
        </Link>
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">No business found.</p>
        </Card>
      ) : (
        <Suspense fallback={null}>
          <AiFlowRunsManager
            businessId={businessId}
            initialRuns={runs}
            flows={flows.map((f) => ({ id: f.id, name: f.name }))}
            flowId={flowId || undefined}
            employeeNames={employeeNames}
          />
        </Suspense>
      )}
    </div>
  );
}
