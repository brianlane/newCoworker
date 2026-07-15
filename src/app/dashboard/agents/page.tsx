import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { AgentsManager } from "@/components/dashboard/AgentsManager";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ draft?: string }> };

export default async function AgentsPage({ searchParams }: Props) {
  const { draft } = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/agents");
  if (!user.email) redirect("/login?redirectTo=/dashboard/agents");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const business = businesses?.[0] ?? null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Agents</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Reusable AI tasks: save instructions once, then run them on any attachment to get the
          same kind of output every time
        </p>
      </div>

      {!business ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">No coworker provisioned yet.</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Get Started →
            </a>
          </div>
        </Card>
      ) : (
        <AgentsManager businessId={business.id} initialDraft={draft === "1"} />
      )}
    </div>
  );
}
