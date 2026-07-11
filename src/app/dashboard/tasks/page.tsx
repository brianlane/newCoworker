/**
 * Staff Task Center (/dashboard/tasks).
 *
 * The working view for the team: one card per lead in motion, combining the
 * active workflow position, lead state (tags + owner), goal events,
 * collected info, and the AI's response reasoning. Visible to every role
 * (view_dashboard); staff logins linked to a roster member start on
 * "My tasks". Data loads client-side from /api/dashboard/tasks.
 */
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { TaskCenter } from "@/components/dashboard/TaskCenter";

export const dynamic = "force-dynamic";

export default async function DashboardTasksPage() {
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

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Tasks</h1>
        <p className="mt-1 text-sm text-parchment/50">
          Every lead in motion: where its workflow sits, its status, the goals it
          has hit, what the AI has collected, and why the AI replied the way it did
        </p>
      </div>
      <TaskCenter
        businessId={ctx.businessId}
        defaultScope={defaultScope}
        hasLinkedEmployee={linkedEmployeeId !== null}
      />
    </div>
  );
}
