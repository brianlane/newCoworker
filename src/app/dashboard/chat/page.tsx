import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { DashboardChat } from "@/components/dashboard/DashboardChat";

export const dynamic = "force-dynamic";

export default async function DashboardChatPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/chat");
  if (!user.email) redirect("/login?redirectTo=/dashboard/chat");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessId(user);
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, status")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("chatTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("chatSubtitle")}
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

  if (business.status !== "online" && business.status !== "high_load") {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("chatTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">{t("chatSubtitle")}</p>
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
