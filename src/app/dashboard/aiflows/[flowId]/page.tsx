import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAiFlow, listAiFlowRuns } from "@/lib/ai-flows/db";
import { friendlyFlowSummary } from "@/components/dashboard/aiflow-labels";
import { statsByStepIdFromRunSteps, type StepStats } from "@/lib/ai-flows/tree";
import { getTenantMailbox, tenantMailboxAddress } from "@/lib/email/tenant-mailbox";
import { Card } from "@/components/ui/Card";
import { AiFlowView } from "@/components/dashboard/AiFlowView";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ flowId: string }> };

export default async function AiFlowViewPage({ params }: Props) {
  const { flowId } = await params;

  const user = await getAuthUser();
  if (!user) redirect(`/login?redirectTo=/dashboard/aiflows/${flowId}`);
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

  const flow = businessId ? await getAiFlow(businessId, flowId) : null;

  // Only offer "View runs" when this flow has actually been triggered/run at
  // least once — a cheap single-row probe scoped to this flow.
  const hasRuns =
    businessId && flow
      ? (await listAiFlowRuns(businessId, { flowId, limit: 1 })).length > 0
      : false;

  // Per-node run stats for the canvas overlay: aggregate the recorded step
  // outcomes of the (up to) 100 most recent runs. Runs don't snapshot the
  // definition, so only runs STARTED AFTER the flow's last edit are counted —
  // older runs executed a different flatten order and their step indices
  // would land on the wrong nodes (statsByStepIdFromRunSteps additionally
  // type-checks each row). Best-effort — the view renders without the overlay
  // when nothing qualifies.
  let statsByStepId: Record<string, StepStats> | undefined;
  if (businessId && flow && hasRuns) {
    const recentRuns = await listAiFlowRuns(businessId, { flowId, limit: 100 });
    const runIds = recentRuns
      .filter((r) => r.created_at >= flow.updated_at)
      // Test runs simulate their sends — their step outcomes would inflate
      // the "ran N×" counts with sends that never happened.
      .filter((r) => (r.context?.trigger as { test_mode?: unknown } | undefined)?.test_mode !== true)
      .map((r) => r.id);
    if (runIds.length > 0) {
      const { data: stepRows } = await db
        .from("ai_flow_run_steps")
        .select("step_index,step_type,status")
        .eq("business_id", businessId)
        .in("run_id", runIds);
      if (stepRows && stepRows.length > 0) {
        statsByStepId = statsByStepIdFromRunSteps(
          flow.definition.steps,
          stepRows as Array<{ step_index: number; step_type: string; status: string }>
        );
      }
    }
  }

  // The AI mailbox is the sender for any send_email step without a connected
  // owner mailbox, so show the real address rather than a generic label. Legacy
  // businesses may not have a row yet; the default local-part is the business
  // UUID (the worker self-heals to the same address on first send), so fall back
  // to that instead of a generic label.
  const mailbox = businessId ? await getTenantMailbox(businessId, db) : null;
  const coworkerEmail = businessId
    ? tenantMailboxAddress(mailbox?.local_part ?? businessId)
    : undefined;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {flow ? (
            <>
              {/* The page's own title: show it in full (wrapped) rather than
                  truncating — the pill hangs off the first line. */}
              <div className="flex items-start gap-2">
                <h1 className="min-w-0 break-words text-2xl font-bold text-parchment">
                  {flow.name}
                </h1>
                <span
                  className={`mt-1.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    flow.enabled
                      ? "bg-claw-green/15 text-claw-green"
                      : "bg-parchment/10 text-parchment/50"
                  }`}
                >
                  {flow.enabled ? "ENABLED" : "OFF"}
                </span>
              </div>
              <p className="mt-1 text-sm text-parchment/50">
                {friendlyFlowSummary(flow.definition)}
              </p>
            </>
          ) : (
            <h1 className="text-2xl font-bold text-parchment">AiFlow not found</h1>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm sm:shrink-0 sm:flex-nowrap sm:whitespace-nowrap">
          {flow && (
            <Link
              href={`/dashboard/aiflows?edit=${flow.id}`}
              className="text-signal-teal hover:underline"
            >
              Edit
            </Link>
          )}
          {flow && hasRuns && (
            <Link
              href={`/dashboard/aiflows/runs?flowId=${flow.id}`}
              className="text-signal-teal hover:underline"
            >
              View runs →
            </Link>
          )}
          <Link href="/dashboard/aiflows" className="text-signal-teal hover:underline">
            ← Back to AiFlows
          </Link>
        </div>
      </div>

      {flow ? (
        <Card>
          <AiFlowView
            definition={flow.definition}
            coworkerEmail={coworkerEmail}
            statsByStepId={statsByStepId}
          />
        </Card>
      ) : (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            This AiFlow does not exist or is not part of your business.
          </p>
        </Card>
      )}
    </div>
  );
}
