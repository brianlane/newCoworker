import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { BrandingEditor } from "@/components/dashboard/BrandingEditor";
import { DedicatedSupportCard } from "@/components/dashboard/DedicatedSupportCard";
import { TeamAccessManager } from "@/components/dashboard/TeamAccessManager";
import { parseBranding } from "@/lib/plans/branding";
import { getEnterpriseSupportContact } from "@/lib/plans/enterprise-support";
import { listBusinessMembers } from "@/lib/db/business-members";
import { listTeamMembers } from "@/lib/db/employees";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { business } = await loadSettingsContext();
  const isEnterprise = business?.tier === "enterprise";

  if (!business || !isEnterprise) {
    return (
      <SettingsPageShell
        title={t("hubTeamTitle")}
        blurb={t("teamPageBlurb")}
      >
        <Card>
          <p className="text-sm text-parchment/60">{t("teamEnterpriseOnly")}</p>
          <Link
            href="/enterprise-offer"
            className="mt-4 inline-block text-sm text-claw-green hover:underline"
          >
            {t("teamEnterpriseCta")}
          </Link>
        </Card>
      </SettingsPageShell>
    );
  }

  const [teamMembers, employees] = await Promise.all([
    listBusinessMembers(business.id),
    listTeamMembers(business.id)
  ]);

  return (
    <SettingsPageShell
      title={t("hubTeamTitle")}
      blurb={t("teamPageBlurb")}
    >
      <DedicatedSupportCard contact={getEnterpriseSupportContact()} />

      <BrandingEditor
        businessId={business.id}
        initialBranding={parseBranding(business.branding)}
      />

      <TeamAccessManager
        businessId={business.id}
        initialMembers={teamMembers.map((m) => ({
          id: m.id,
          email: m.email,
          role: m.role,
          status: m.status,
          created_at: m.created_at,
          employee_id: m.employee_id
        }))}
        employees={employees.map((e) => ({ id: e.id, name: e.name }))}
      />
    </SettingsPageShell>
  );
}
