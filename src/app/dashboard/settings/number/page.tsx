/**
 * Phone number settings: bring-your-own-number wizard + port status.
 * Server component resolves the business and existing port requests; the
 * client component owns the wizard and cancel/refresh interactions.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ByonNumberPorting } from "@/components/dashboard/ByonNumberPorting";
import { listByonPortRequests } from "@/lib/byon/port-requests";

export const dynamic = "force-dynamic";

export default async function NumberSettingsPage() {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/settings/number");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Phone Number</h1>
          <p className="text-sm text-parchment/50 mt-1">Bring your existing business number</p>
        </div>
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
      </div>
    );
  }

  const requests = await listByonPortRequests(business.id, db);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Phone Number</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Bring the business number your customers already know — it transfers to your AI coworker
          in about a week
        </p>
      </div>
      <ByonNumberPorting businessId={business.id} initialRequests={requests} />
    </div>
  );
}
