/**
 * Bookings page: manage the business's public self-serve booking link
 * (/book/<token>) and see upcoming booked appointments. Server component
 * resolves the business; the client component owns settings interactions.
 */

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { BookingPageManager } from "@/components/dashboard/BookingPageManager";

export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/bookings");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  if (!business) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("bookingsTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">{t("bookingsEmptySubtitle")}</p>
        </div>
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-claw-green/90 transition-colors"
            >{t("getStarted")}</a>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("bookingsTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("bookingsSubtitle")}</p>
      </div>
      <BookingPageManager businessId={business.id} />
    </div>
  );
}
