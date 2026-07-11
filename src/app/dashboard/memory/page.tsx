import { redirect } from "next/navigation";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessConfig } from "@/lib/db/configs";
import { Card } from "@/components/ui/Card";
import { MemoryEditor } from "@/components/dashboard/MemoryEditor";
import { SeoInsightsCard, type SeoReportView } from "@/components/dashboard/SeoInsightsCard";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, tier, website_url, name, business_type")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .limit(1);

  const business = businesses?.[0];
  const businessId = business?.id ?? null;
  const tier = business?.tier ?? null;
  const config = businessId ? await getBusinessConfig(businessId) : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Coworker Memory</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Review and manage what your AI coworker knows about your business
        </p>
      </div>

      {!config ? (
        <Card>
          <p className="text-parchment/50 text-sm">Memory not initialized. Provision your coworker first.</p>
        </Card>
      ) : (
        <>
          <MemoryEditor
            businessId={businessId!}
            tier={tier ?? undefined}
            businessName={business?.name ?? undefined}
            businessType={business?.business_type ?? undefined}
            initialSoul={config.soul_md}
            initialIdentity={config.identity_md}
            initialMemory={config.memory_md}
            initialWebsiteUrl={business?.website_url ?? ""}
            initialWebsiteMd={config.website_md ?? ""}
          />
          <SeoInsightsCard
            businessId={businessId!}
            websiteUrl={business?.website_url ?? null}
            initialReport={
              ((config as { seo_report?: SeoReportView | null }).seo_report ?? null)
            }
          />
        </>
      )}
    </div>
  );
}
