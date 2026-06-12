/**
 * Employees page: the AiFlow team roster, with working info and stats.
 *
 * Same table route_to_team rotates leads through (ai_flow_team_members) —
 * previously seeded by scripts only, with no UI. The page server-renders
 * the roster + time off + routing stats and hands everything to the
 * EmployeesManager client island for CRUD.
 */

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import {
  listEmployeeRoutingStats,
  listTeamMembers,
  listTimeOff
} from "@/lib/db/employees";
import { sharedCalendarStatus } from "@/lib/calendar-tools/shared-calendar";
import { EmployeesManager } from "@/components/dashboard/EmployeesManager";

export const dynamic = "force-dynamic";

export default async function DashboardEmployeesPage() {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/employees");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Employees</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Your team roster for lead routing
          </p>
        </div>
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">No coworker provisioned yet.</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Get Started →
            </a>
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
        <h1 className="text-2xl font-bold text-parchment">Employees</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Who your AI coworker offers leads to, when they work, and when
          they&apos;re out
        </p>
      </div>

      <Card padding="sm" className="border-signal-teal/30 bg-signal-teal/5">
        <p className="text-xs text-parchment/70 leading-relaxed">
          Leads are offered to active employees in fair rotation. Time off
          always wins — an employee who is out today is never offered a lead,
          even when a flow routes directly to them. A weekly schedule (when
          set) limits offers to working hours; preferred times only move
          someone to the front of the line, never out of it.
        </p>
      </Card>

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
