import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlows } from "@/lib/ai-flows/db";
import { reviewRequestTemplate } from "@/lib/ai-flows/templates";
import { Card } from "@/components/ui/Card";
import { AiFlowsManager } from "@/components/dashboard/AiFlowsManager";
import { ReviewRequestCard } from "@/components/dashboard/ReviewRequestCard";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ edit?: string; adapt?: string }> };

export default async function AiFlowsPage({ searchParams }: Props) {
  const { edit, adapt } = await searchParams;

  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_aiflows");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, business_type")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;
  const businessType = (businesses?.[0]?.business_type as string | null | undefined) ?? null;

  const flows = businessId ? await listAiFlows(businessId) : [];
  // The review-request starter (matched by name, like the Meta guide's) — the
  // template needs a link only for definition building, not for detection.
  const reviewStarterName = reviewRequestTemplate("https://example.invalid").name;
  const reviewStarter = flows.find((f) => f.name === reviewStarterName) ?? null;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">AiFlows</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Automate multi-step workflows: start from an inbound text or email, on a
            schedule, or on demand: browse links, extract details, ask for approval, and
            send texts or emails.
          </p>
        </div>
        {businessId && (
          <div className="flex flex-wrap items-center gap-4 text-sm sm:shrink-0 sm:flex-nowrap sm:whitespace-nowrap">
            <Link
              href="/dashboard/aiflows/guides/meta-leads"
              className="text-signal-teal hover:underline"
            >
              How to: Meta ad leads
            </Link>
            <Link
              href="/dashboard/aiflows/import-leads"
              className="text-signal-teal hover:underline"
            >
              Import leads
            </Link>
            <Link
              href="/dashboard/aiflows/library"
              className="text-signal-teal hover:underline"
            >
              Browse library
            </Link>
            <Link
              href="/dashboard/aiflows/runs"
              className="text-signal-teal hover:underline"
            >
              View runs →
            </Link>
          </div>
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
        <>
          <ReviewRequestCard
            businessId={businessId}
            installedFlow={
              reviewStarter ? { id: reviewStarter.id, enabled: reviewStarter.enabled } : null
            }
          />
          <AiFlowsManager
            businessId={businessId}
            businessType={businessType}
            initialFlows={flows}
            initialEditId={edit ?? null}
            initialAdaptDraft={adapt === "1"}
          />
        </>
      )}
    </div>
  );
}
