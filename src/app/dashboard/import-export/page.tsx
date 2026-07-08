/**
 * Import / Export page: CSV in and out for the business's people data
 * (contacts directory + employee roster), modeled on BizBlasts' /manage/csv.
 * Server component resolves the business; the client component owns the
 * download/upload interactions.
 */

import { redirect } from "next/navigation";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { CsvImportExport } from "@/components/dashboard/CsvImportExport";

export const dynamic = "force-dynamic";

export default async function ImportExportPage() {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/import-export");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Import / Export</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Move your business data in and out as CSV files
          </p>
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

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Import / Export</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Move your business data in and out as CSV files: bring contacts from another tool or
          take a backup
        </p>
      </div>
      <CsvImportExport businessId={business.id} />
    </div>
  );
}
