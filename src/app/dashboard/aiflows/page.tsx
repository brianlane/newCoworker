import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlows } from "@/lib/ai-flows/db";
import { Card } from "@/components/ui/Card";
import { AiFlowsManager } from "@/components/dashboard/AiFlowsManager";

export const dynamic = "force-dynamic";

export default async function AiFlowsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  const flows = businessId ? await listAiFlows(businessId) : [];

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">AiFlows</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Automate multi-step workflows: start from an inbound text or email, on a
            schedule, or on demand — browse links, extract details, ask for approval, and
            send texts or emails.
          </p>
        </div>
        {businessId && (
          <Link
            href="/dashboard/aiflows/runs"
            className="shrink-0 whitespace-nowrap text-sm text-signal-teal hover:underline"
          >
            View runs →
          </Link>
        )}
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            Provision your coworker first to create AiFlows.
          </p>
          <a href="/onboard" className="block text-center text-sm text-signal-teal hover:underline">
            Get started →
          </a>
        </Card>
      ) : (
        <AiFlowsManager businessId={businessId} initialFlows={flows} />
      )}
    </div>
  );
}
