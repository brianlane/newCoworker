import { notFound, redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getAiFlowLibraryEntry } from "@/lib/ai-flows/library";
import { Card } from "@/components/ui/Card";
import { AiFlowView } from "@/components/dashboard/AiFlowView";
import { AiFlowLibraryActions } from "@/components/dashboard/AiFlowLibraryActions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ templateKey: string }> };

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-md border border-parchment/10 bg-deep-ink/20 px-3 py-2">
      <div className="text-lg font-semibold text-parchment">{value}</div>
      <div className="text-[11px] text-parchment/50">{label}</div>
    </div>
  );
}

export default async function AiFlowLibraryDetailPage({ params }: Props) {
  const { templateKey } = await params;

  const user = await getAuthUser();
  if (!user) redirect(`/login?redirectTo=/dashboard/aiflows/library/${templateKey}`);
  if (!user.email) redirect("/login");

  const entry = await getAiFlowLibraryEntry(templateKey);
  if (!entry) notFound();

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

  const perDay =
    typeof entry.stats?.runsPerDay === "number"
      ? (entry.stats.runsPerDay as number)
      : Math.round((entry.runs_last_7d / 7) * 100) / 100;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* The page's own title: show it in full (wrapped) rather than
              truncating — the category pill hangs off the first line. */}
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 break-words text-2xl font-bold text-parchment">
              {entry.title}
            </h1>
            {entry.category && (
              <span className="mt-1.5 shrink-0 rounded-full border border-parchment/15 bg-deep-ink/40 px-2 py-0.5 text-[10px] text-parchment/60">
                {entry.category}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-parchment/50">{entry.summary}</p>
        </div>
        <Link
          href="/dashboard/aiflows/library"
          className="shrink-0 whitespace-nowrap text-sm text-signal-teal hover:underline"
        >
          ← Back to library
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat value={entry.total_successful_runs.toLocaleString()} label="Successful runs" />
        <Stat value={entry.businesses_using.toLocaleString()} label="Businesses" />
        <Stat value={entry.download_count.toLocaleString()} label="Uses" />
        <Stat value={`${perDay}/day`} label="Runs (7-day avg)" />
        <Stat
          value={entry.last_run_at ? new Date(entry.last_run_at).toLocaleDateString() : "–"}
          label="Last run"
        />
      </div>

      <Card className="space-y-4">
        <AiFlowLibraryActions businessId={businessId} libraryId={entry.id} />
        <p className="text-[11px] text-parchment/40">
          Personal details (phone numbers, emails, names) are removed from library flows.
          When you use one, your own details are filled in automatically.
        </p>
      </Card>

      <Card>
        <AiFlowView definition={entry.scrubbed_definition} />
      </Card>
    </div>
  );
}
