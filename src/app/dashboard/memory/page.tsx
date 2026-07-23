import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessConfig } from "@/lib/db/configs";
import { Card } from "@/components/ui/Card";
import { MemoryEditor } from "@/components/dashboard/MemoryEditor";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const t = await getTranslations("dashboard.pages");
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
        <h1 className="text-2xl font-bold text-parchment">{t("memoryTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {t("memorySubtitle")}
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
            initialCrawlReport={config.website_crawl_report ?? null}
          />
          {(config.memory_archive_md ?? "").trim().length > 0 && (
            <Card>
              <details className="text-sm text-parchment/60">
                <summary className="cursor-pointer select-none font-semibold text-parchment hover:text-parchment/80">
                  {t("memoryArchiveSummary", {
                    chars: (config.memory_archive_md ?? "").length.toLocaleString()
                  })}
                </summary>
                <p className="mt-2 text-xs text-parchment/50">{t("memoryArchiveHint")}</p>
                <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-parchment/10 bg-ink/40 p-3 text-xs text-parchment/50">
                  {config.memory_archive_md}
                </pre>
              </details>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
