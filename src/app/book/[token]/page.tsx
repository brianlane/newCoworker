/**
 * Public self-serve booking page — the durable, shareable link
 * (/book/<ncb_token>) a business hands to anyone who should book time on
 * its calendar. Fully public by design (no login, no account): the
 * unguessable capability token is the only credential, exactly like the
 * white-glove intake link. Layout mirrors the familiar two-panel booking
 * pages (business panel left, calendar and times right).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BOOKING_PAGE_TOKEN_REGEX } from "@/lib/booking-page/keys";
import { getBookingPageContext } from "@/lib/booking-page/service";
import { PublicBookingPage } from "@/components/booking/PublicBookingPage";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("bookingPage");
  return { title: t("metaTitle"), robots: { index: false } };
}

export default async function BookPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Fail closed on malformed tokens without hitting the DB.
  if (!BOOKING_PAGE_TOKEN_REGEX.test(token)) notFound();

  const resolved = await getBookingPageContext(token);
  if (!resolved.ok) notFound();
  const { context } = resolved;

  const t = await getTranslations("bookingPage");

  return (
    <main className="min-h-screen bg-deep-ink px-4 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <PublicBookingPage
          token={token}
          businessName={context.businessName}
          description={context.description}
          allowedDurations={context.allowedDurations}
          videoCall={context.videoCall}
          strings={{
            eventTitle: t("eventTitle", { business: context.businessName }),
            durationMinutes: t("durationMinutes"),
            videoCallNote: t("videoCallNote"),
            selectDateTime: t("selectDateTime"),
            timezoneLabel: t("timezoneLabel"),
            noSlotsThisMonth: t("noSlotsThisMonth"),
            loadingSlots: t("loadingSlots"),
            slotsUnavailable: t("slotsUnavailable"),
            backToCalendar: t("backToCalendar"),
            confirmHeading: t("confirmHeading"),
            nameLabel: t("nameLabel"),
            phoneLabel: t("phoneLabel"),
            emailLabel: t("emailLabel"),
            noteLabel: t("noteLabel"),
            submitButton: t("submitButton"),
            submitting: t("submitting"),
            slotTaken: t("slotTaken"),
            submitFailed: t("submitFailed"),
            checkDetails: t("checkDetails"),
            bookedHeading: t("bookedHeading"),
            bookedBody: t("bookedBody", { business: context.businessName }),
            bookedVideoNote: t("bookedVideoNote"),
            poweredBy: t("poweredBy"),
            weekdaysShort: [
              t("weekdaySun"),
              t("weekdayMon"),
              t("weekdayTue"),
              t("weekdayWed"),
              t("weekdayThu"),
              t("weekdayFri"),
              t("weekdaySat")
            ]
          }}
        />
      </div>
    </main>
  );
}
