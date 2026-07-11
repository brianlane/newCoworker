import Link from "next/link";
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
  const { business } = await loadSettingsContext();
  const isEnterprise = business?.tier === "enterprise";

  if (!business || !isEnterprise) {
    return (
      <SettingsPageShell
        title="Team"
        blurb="Dashboard access, branding, and dedicated support"
      >
        <Card>
          <p className="text-sm text-parchment/60">
            Team access, white-label branding, and dedicated support are Enterprise features.
          </p>
          <Link
            href="/enterprise-offer"
            className="mt-4 inline-block text-sm text-claw-green hover:underline"
          >
            Talk to us about Enterprise →
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
      title="Team"
      blurb="Dashboard access, branding, and dedicated support"
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
