import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { DocumentsManager } from "@/components/dashboard/DocumentsManager";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const businessId = await resolveActiveBusinessId(user);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("documentsTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("documentsSubtitle")}</p>
      </div>

      {!businessId ? (
        <Card>
          <p className="text-parchment/50 text-sm">
            No business yet. Provision your coworker first.
          </p>
        </Card>
      ) : (
        <DocumentsManager businessId={businessId} />
      )}
    </div>
  );
}
