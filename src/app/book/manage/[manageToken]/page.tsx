/**
 * Invitee self-serve page for ONE booking made on the public booking page
 * (/book/manage/<ncbm_token>).
 *
 * The link rides the confirmation, so someone who needs a different time
 * can move or cancel it themselves instead of texting the business and
 * waiting for a person. Public by design like the page itself: the
 * unguessable per-booking token is the only credential, and it grants
 * nothing beyond this one appointment.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parseBookingManageToken } from "@/lib/booking-page/keys";
import { getManagedBooking } from "@/lib/booking-page/manage";
import { ManageBookingPage } from "@/components/booking/ManageBookingPage";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("bookingPage");
  return { title: t("manageMetaTitle"), robots: { index: false } };
}

export default async function ManageBooking({
  params
}: {
  params: Promise<{ manageToken: string }>;
}) {
  const { manageToken } = await params;
  // Fail closed without a DB hit on a malformed segment.
  if (!parseBookingManageToken(manageToken)) notFound();

  const resolved = await getManagedBooking(manageToken);
  if (!resolved.ok) notFound();
  const { view } = resolved;

  const t = await getTranslations("bookingPage");

  return (
    <main className="min-h-screen bg-deep-ink px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <ManageBookingPage
          token={manageToken}
          businessName={view.businessName}
          timezone={view.timezone}
          startIso={view.startIso}
          durationMinutes={view.durationMinutes}
          zoomJoinUrl={view.zoomJoinUrl}
          changeable={view.changeable}
          strings={{
            heading: t("manageHeading"),
            withBusiness: t("manageWithBusiness", { business: view.businessName }),
            durationMinutes: t("durationMinutes"),
            joinLabel: t("bookedZoomLinkLabel"),
            rescheduleButton: t("manageRescheduleButton"),
            cancelButton: t("manageCancelButton"),
            cancelConfirm: t("manageCancelConfirm"),
            keepButton: t("manageKeepButton"),
            pickNewTime: t("managePickNewTime"),
            loadingSlots: t("loadingSlots"),
            noSlots: t("noSlotsThisMonth"),
            tooLate: t("manageTooLate"),
            canceledHeading: t("manageCanceledHeading"),
            canceledBody: t("manageCanceledBody", { business: view.businessName }),
            movedHeading: t("manageMovedHeading"),
            slotTaken: t("slotTaken"),
            changeFailed: t("manageChangeFailed"),
            backButton: t("backToCalendar"),
            poweredBy: t("poweredBy")
          }}
        />
      </div>
    </main>
  );
}
