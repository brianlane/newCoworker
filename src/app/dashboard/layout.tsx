import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isCanceledInGrace } from "@/lib/db/subscriptions";
import type { CancelReason, SubscriptionRow } from "@/lib/db/subscriptions";
import { GraceBanner } from "@/components/billing/GraceBanner";
import { reconcilePendingEmailChange } from "@/lib/account/email-change";

type EmbeddedSubscriptionRow = Pick<
  SubscriptionRow,
  "status" | "grace_ends_at" | "wiped_at" | "cancel_reason" | "created_at"
>;

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");

  let grace:
    | { graceEndsAt: string; reason: Parameters<typeof GraceBanner>[0]["reason"] }
    | null = null;
  let businessId: string | null = null;
  if (user.email) {
    // Single-round-trip grace lookup. Next.js layouts re-execute on every
    // navigation under `/dashboard`, so we previously paid 2 sequential
    // DB round-trips per page render (businesses lookup + subscriptions
    // lookup) for every signed-in user — even on pages unrelated to
    // billing (soul editor, voice usage, etc.). Fold both lookups into
    // one PostgREST query that selects the most recent business by
    // owner_email and embeds the subscriptions for that business in the
    // same response. We then pick the most recent subscription on the
    // server before deciding whether to render `<GraceBanner />`.
    const db = await createSupabaseServiceClient();
    // If the owner just confirmed an account-email change (possibly on another
    // device, or via a plain password sign-in that never hit /api/auth/callback),
    // mirror the new email onto their business BEFORE the owner_email lookup
    // below — otherwise that lookup would miss and the dashboard would render as
    // if they had no business. No-op (one cheap PK read) when nothing is pending.
    await reconcilePendingEmailChange(user.userId, user.email, db);
    const { data: businesses } = await db
      .from("businesses")
      .select("id, subscriptions(status, grace_ends_at, wiped_at, cancel_reason, created_at)")
      .eq("owner_email", user.email)
      .order("created_at", { ascending: false })
      .limit(1);
    const business = businesses?.[0] ?? null;
    businessId = business?.id ?? null;
    const embeddedSubs = (business?.subscriptions ?? []) as EmbeddedSubscriptionRow[];
    const subscription =
      embeddedSubs.length === 0
        ? null
        : embeddedSubs
            .slice()
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (subscription?.grace_ends_at && isCanceledInGrace(subscription)) {
      grace = {
        graceEndsAt: subscription.grace_ends_at,
        reason: subscription.cancel_reason as CancelReason | null
      };
    }
  }

  return (
    <div className="flex h-screen bg-deep-ink">
      <DashboardSidebar userEmail={user.email} businessId={businessId} />
      <main className="flex-1 overflow-y-auto p-4 pt-16 lg:p-6">
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
