/**
 * The table-creation wizard. Manager and up, because defining a table is
 * schema work.
 */
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { Card } from "@/components/ui/Card";
import { CreateTableWizard } from "@/components/dashboard/CreateTableWizard";

export const dynamic = "force-dynamic";

export default async function NewCustomTablePage() {
  const t = await getTranslations("dashboard.pages");
  const tt = await getTranslations("dashboard.tables");
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/tables/new");

  const ctx = await resolveActiveBusinessContext(user);
  if (!ctx.businessId) redirect("/dashboard/tables");

  const canManage = ctx.role === "owner" || ctx.role === "manager";
  if (!canManage) {
    // A staff login that types the URL gets the same sentence the directory
    // shows them, rather than a form whose Create button can only 403.
    return (
      <div className="max-w-4xl space-y-6">
        <h1 className="text-2xl font-bold text-parchment">{t("tablesNewTitle")}</h1>
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">{tt("askManager")}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("tablesNewTitle")}</h1>
        <p className="mt-1 text-sm text-parchment/50">{t("tablesNewSubtitle")}</p>
      </div>
      <CreateTableWizard businessId={ctx.businessId} />
    </div>
  );
}
