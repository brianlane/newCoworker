/**
 * Staff Task Center (/dashboard/tasks).
 *
 * The working view for the team, in two layouts:
 *  - Board (default): a GoHighLevel-style pipeline board — columns are the
 *    stages of an owner-defined pipeline (each stage backed by a contact
 *    tag), cards are leads, and drag-and-drop moves a lead between stages
 *    (firing the same tag automation as any other tag change).
 *  - List: one detailed card per lead in motion (workflow position, lead
 *    state, goal events, collected info, response reasoning).
 *
 * Visible to every role (view_dashboard); staff logins linked to a roster
 * member start on "My tasks". Data loads client-side from
 * /api/dashboard/tasks + /api/dashboard/pipelines. `?lead=<e164>` (the
 * activity feed's deep link) highlights that lead's card.
 */
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { TasksWorkspace } from "@/components/dashboard/TasksWorkspace";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ lead?: string }> };

export default async function DashboardTasksPage({ searchParams }: Props) {
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/tasks");

  const db = await createSupabaseServiceClient();
  const ctx = await resolveActiveBusinessContext(user, db);

  if (!ctx.businessId) {
    return (
      <div className="max-w-4xl space-y-6">
        <h1 className="text-2xl font-bold text-parchment">Tasks</h1>
        <Card>
          <div className="py-8 text-center">
            <p className="mb-4 text-parchment/60">No coworker provisioned yet.</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green px-5 py-2.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
            >
              Get Started →
            </a>
          </div>
        </Card>
      </div>
    );
  }

  // Staff linked to a roster member start on "My tasks"; owners/managers
  // (and unlinked staff) see the whole board first.
  let linkedEmployeeId: string | null = null;
  if (ctx.role === "staff" || ctx.role === "manager") {
    const { data: memberRow } = await db
      .from("business_members")
      .select("employee_id")
      .eq("business_id", ctx.businessId)
      .eq("email", user.email.trim().toLowerCase())
      .neq("status", "revoked")
      .maybeSingle();
    linkedEmployeeId =
      (memberRow as { employee_id?: string | null } | null)?.employee_id ?? null;
  }
  const defaultScope = ctx.role === "staff" && linkedEmployeeId ? "mine" : "all";
  // Pipeline administration (create boards, edit stages) is manager+, same
  // bar as the manage_settings routes it calls.
  const canManagePipelines = ctx.role === "owner" || ctx.role === "manager";
  const rawLead = (await searchParams).lead ?? null;
  // Same shape the contact routes accept; anything else is ignored.
  const highlightLead =
    rawLead && /^(\+[1-9]\d{6,15}|\d{3,8})$/.test(rawLead) ? rawLead : null;

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Tasks</h1>
        <p className="mt-1 text-sm text-parchment/50">
          Every lead in motion: drag them through your pipeline, or open the list
          for the full story — workflow position, goals, collected info, and why
          the AI replied the way it did
        </p>
      </div>
      <TasksWorkspace
        businessId={ctx.businessId}
        defaultScope={defaultScope}
        hasLinkedEmployee={linkedEmployeeId !== null}
        canManagePipelines={canManagePipelines}
        highlightLead={highlightLead}
      />
    </div>
  );
}
