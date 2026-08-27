/**
 * Tables: the index of every dataset the business has.
 *
 * Two groups, and the split is the whole point. "Tables you made" are the
 * owner's own tables, and they open here. "Tables you already have" are the
 * ones the platform maintains (Leads, Contacts, Deals, To-dos, Documents,
 * Employees, Bookings), and they open at their OWN page rather than being
 * re-rendered here.
 *
 * That deep-link is deliberate. LeadDataGrid is bound to pipelines and its
 * Stage cell fires tag automation, goal events, and Meta CAPI feedback;
 * mounting it at a second URL would either fork the component or give one
 * dataset two homes. One dataset, one canonical URL, always. What this page
 * adds that no existing page does is the overview: how much data of each
 * kind you have, in one place.
 */
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { Card } from "@/components/ui/Card";
import { TablesDirectory } from "@/components/dashboard/TablesDirectory";

export const dynamic = "force-dynamic";

export default async function DashboardTablesPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/tables");

  const ctx = await resolveActiveBusinessContext(user);
  if (!ctx.businessId) {
    return (
      <div className="max-w-6xl space-y-6">
        <h1 className="text-2xl font-bold text-parchment">{t("tablesTitle")}</h1>
        <Card>
          <div className="py-8 text-center">
            <p className="mb-4 text-parchment/60">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green px-5 py-2.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-claw-green/90"
            >
              {t("getStarted")}
            </a>
          </div>
        </Card>
      </div>
    );
  }

  // Defining a table is schema work, the same bar as pipelines. Staff still
  // see every table and can work the rows inside them.
  const canManage = ctx.role === "owner" || ctx.role === "manager";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("tablesTitle")}</h1>
        <p className="mt-1 text-sm text-parchment/50">{t("tablesSubtitle")}</p>
      </div>
      <TablesDirectory businessId={ctx.businessId} canManage={canManage} />
    </div>
  );
}
