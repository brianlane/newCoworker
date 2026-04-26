import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription, isCanceledInGrace } from "@/lib/db/subscriptions";
import { GraceBanner } from "@/components/billing/GraceBanner";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");

  let grace:
    | { graceEndsAt: string; reason: Parameters<typeof GraceBanner>[0]["reason"] }
    | null = null;
  if (user.email) {
    const db = await createSupabaseServiceClient();
    const { data: businesses } = await db
      .from("businesses")
      .select("id")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0] ?? null;
    const subscription = business ? await getSubscription(business.id) : null;
    if (subscription?.grace_ends_at && isCanceledInGrace(subscription)) {
      grace = {
        graceEndsAt: subscription.grace_ends_at,
        reason: subscription.cancel_reason
      };
    }
  }

  return (
    <div className="flex h-screen bg-deep-ink">
      <DashboardSidebar userEmail={user.email} />
      <main className="flex-1 overflow-y-auto p-6">
        {grace && (
          <div className="mb-6">
            <GraceBanner graceEndsAt={grace.graceEndsAt} reason={grace.reason} />
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
