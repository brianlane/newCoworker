import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { DocumentsManager } from "@/components/dashboard/DocumentsManager";

export const dynamic = "force-dynamic";

export default async function DocumentsPage({
  searchParams
}: {
  searchParams: Promise<{ doc?: string; folder?: string }>;
}) {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const q = await searchParams;
  // Legacy deep links (?doc=<id>, e.g. from old Zoom import notes) land on
  // the document's own page now.
  if (q.doc && /^[0-9a-f-]{36}$/i.test(q.doc)) {
    redirect(`/dashboard/documents/${q.doc}`);
  }

  const businessId = await resolveActiveBusinessId(user);
  const folder = q.folder?.trim() ? q.folder.trim() : null;

  return (
    <div className="space-y-6 max-w-4xl">
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
        <DocumentsManager businessId={businessId} folder={folder} />
      )}
    </div>
  );
}
