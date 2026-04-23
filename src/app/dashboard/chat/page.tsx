import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { DashboardChat } from "@/components/dashboard/DashboardChat";

export const dynamic = "force-dynamic";

export default async function DashboardChatPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/chat");
  if (!user.email) redirect("/login?redirectTo=/dashboard/chat");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, status")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Chat with your coworker</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Private chat with your local AI coworker
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

  if (business.status !== "online" && business.status !== "high_load") {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Chat with your coworker</h1>
          <p className="text-sm text-parchment/50 mt-1">Private chat with your local AI coworker</p>
        </div>
        <Card className="border-signal-teal/40 bg-signal-teal/5">
          <p className="text-sm font-semibold text-signal-teal">Still provisioning</p>
          <p className="text-xs text-parchment/60 mt-1">
            Your coworker&rsquo;s server is being set up. Chat will be available here as soon as
            provisioning finishes. This usually takes a few minutes.
          </p>
        </Card>
      </div>
    );
  }

  return <DashboardChat businessId={business.id} businessName={business.name} />;
}
