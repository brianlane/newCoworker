/**
 * Employees page: the AiFlow team roster, with working info and stats.
 *
 * Same table route_to_team rotates leads through (ai_flow_team_members) —
 * previously seeded by scripts only, with no UI. The page server-renders
 * the roster + time off + routing stats and hands everything to the
 * EmployeesManager client island for CRUD.
 */

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import {
  listEmployeeRoutingStats,
  listTeamMembers,
  listTimeOff
} from "@/lib/db/employees";
import { sharedCalendarStatus } from "@/lib/calendar-tools/shared-calendar";
import { EmployeesManager } from "@/components/dashboard/EmployeesManager";
import { LeadAssignmentSettings } from "@/components/dashboard/LeadAssignmentSettings";
import { HumanHandoffSettings } from "@/components/dashboard/HumanHandoffSettings";

export const dynamic = "force-dynamic";

export default async function DashboardEmployeesPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/employees");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, lead_auto_assign, needs_human_team_first")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business =
    (businesses?.[0] as
      | { id: string; name: string; lead_auto_assign?: boolean; needs_human_team_first?: boolean }
      | undefined) ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("employeesTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("employeesEmptySubtitle")}
          </p>
        </div>
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >{t("getStarted")}</a>
          </div>
        </Card>
      </div>
    );
  }

  const [members, timeOff, stats, sharedCalendar] = await Promise.all([
    listTeamMembers(business.id),
    listTimeOff(business.id),
    listEmployeeRoutingStats(business.id),
    sharedCalendarStatus(business.id)
  ]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("employeesTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {t("employeesSubtitle")}
        </p>
      </div>

      <LeadAssignmentSettings
        businessId={business.id}
        initialLeadAutoAssign={business.lead_auto_assign === true}
      />

      <HumanHandoffSettings
        businessId={business.id}
        initialTeamFirst={business.needs_human_team_first === true}
      />

      <EmployeesManager
        businessId={business.id}
        initialMembers={members}
        initialTimeOff={timeOff}
        initialStats={stats}
        initialSharedCalendar={sharedCalendar}
      />
    </div>
  );
}
