/**
 * One custom table: the grid, the Columns panel, and Recent changes.
 *
 * The table is loaded server-side so a bad or cross-tenant id is a 404 page
 * rather than a grid that renders empty and reads as "no data yet".
 */
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { Card } from "@/components/ui/Card";
import { CustomTableWorkspace } from "@/components/dashboard/CustomTableWorkspace";
import { getCustomTable } from "@/lib/custom-tables/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  params: Promise<{ tableId: string }>;
  searchParams: Promise<{ created?: string; edit?: string; row?: string }>;
};

export default async function CustomTablePage({ params, searchParams }: Props) {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/tables");

  const ctx = await resolveActiveBusinessContext(user);
  if (!ctx.businessId) redirect("/dashboard/tables");

  const { tableId } = await params;
  const notFound = (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold text-parchment">{t("tablesTitle")}</h1>
      <Card>
        <p className="py-6 text-center text-sm text-parchment/60">{t("tableNotFound")}</p>
      </Card>
    </div>
  );
  if (!UUID_RE.test(tableId)) return notFound;

  // Business-scoped, so another tenant's id reads as gone rather than
  // confirming it exists.
  const table = await getCustomTable(ctx.businessId, tableId).catch(() => null);
  if (!table) return notFound;

  const query = await searchParams;
  const canManage = ctx.role === "owner" || ctx.role === "manager";

  return (
    <div className="max-w-6xl space-y-6">
      <CustomTableWorkspace
        businessId={ctx.businessId}
        table={table}
        canManage={canManage}
        justCreated={query.created === "1"}
        openColumns={query.edit === "columns"}
        openRowId={query.row ?? null}
      />
    </div>
  );
}
