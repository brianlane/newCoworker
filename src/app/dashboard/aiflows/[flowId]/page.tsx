import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAiFlow } from "@/lib/ai-flows/db";
import { summarizeDefinition } from "@/lib/ai-flows/schema";
import { Card } from "@/components/ui/Card";
import { AiFlowView } from "@/components/dashboard/AiFlowView";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ flowId: string }> };

export default async function AiFlowViewPage({ params }: Props) {
  const { flowId } = await params;

  const user = await getAuthUser();
  if (!user) redirect(`/login?redirectTo=/dashboard/aiflows/${flowId}`);
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  const flow = businessId ? await getAiFlow(businessId, flowId) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {flow ? (
            <>
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold text-parchment">{flow.name}</h1>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    flow.enabled
                      ? "bg-claw-green/15 text-claw-green"
                      : "bg-parchment/10 text-parchment/50"
                  }`}
                >
                  {flow.enabled ? "ENABLED" : "OFF"}
                </span>
              </div>
              <p className="mt-1 truncate text-sm text-parchment/50">
                {summarizeDefinition(flow.definition)}
              </p>
            </>
          ) : (
            <h1 className="text-2xl font-bold text-parchment">AiFlow not found</h1>
          )}
        </div>
        <Link
          href="/dashboard/aiflows"
          className="shrink-0 whitespace-nowrap text-sm text-signal-teal hover:underline"
        >
          ← Back to AiFlows
        </Link>
      </div>

      {flow ? (
        <Card>
          <AiFlowView definition={flow.definition} />
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
