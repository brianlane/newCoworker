import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listAiFlowLibrary } from "@/lib/ai-flows/library";
import { Card } from "@/components/ui/Card";
import { AiFlowLibraryBrowser } from "@/components/dashboard/AiFlowLibraryBrowser";

export const dynamic = "force-dynamic";

export default async function AiFlowLibraryPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/aiflows/library");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;

  const entries = await listAiFlowLibrary();

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">AiFlow library</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Popular automations other businesses run successfully. Personal details are
            removed — pick one, and we&apos;ll adapt it to your number and team.
          </p>
        </div>
        <Link
          href="/dashboard/aiflows"
          className="shrink-0 whitespace-nowrap text-sm text-signal-teal hover:underline"
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
