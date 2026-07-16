/**
 * Marketing page: email campaigns to a tag-filtered audience plus the
 * content calendar (campaigns grouped by month). Server component resolves
 * the business; the client component owns composing/scheduling.
 */

import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { CampaignsManager } from "@/components/dashboard/CampaignsManager";

export const dynamic = "force-dynamic";

export default async function MarketingPage() {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/marketing");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Marketing</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Email campaigns to your contacts — every send is reviewed and scheduled by you, and
          every mail carries a one-click unsubscribe.
        </p>
      </div>
      {business ? (
        <CampaignsManager businessId={business.id} />
      ) : (
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
      )}
    </div>
  );
}
