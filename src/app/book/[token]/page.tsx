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
import { getLocale, getTranslations } from "next-intl/server";
import { parseBookingPageRef } from "@/lib/booking-page/keys";
import { getBookingPageContext } from "@/lib/booking-page/service";
import { activeIntakeQuestions, parseIntakeQuestions } from "@/lib/booking-page/intake";
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
  // Fail closed without a DB hit unless the segment is a well-formed
  // capability token OR vanity slug (the two shapes are disjoint).
  if (!parseBookingPageRef(token)) notFound();

  const resolved = await getBookingPageContext(token);
  const t = await getTranslations("bookingPage");
  const locale = await getLocale();

  // A well-formed link that does not resolve is a REAL page turned off (or
  // rotated away), and whoever holds it was invited by the business: a bare
  // 404 reads as "this business is broken". Say what is true instead.
  if (!resolved.ok) {
    return (
      <main className="min-h-screen bg-deep-ink px-4 py-10">
        <div className="mx-auto w-full max-w-lg pt-16 text-center">
          <h1 className="text-xl font-semibold text-parchment">{t("unavailableHeading")}</h1>
          <p className="mt-3 rounded-md border border-spark-orange/40 bg-spark-orange/10 px-4 py-3 text-sm text-spark-orange">
            {t("unavailableBody")}
          </p>
        </div>
      </main>
    );
  }
  const { context } = resolved;

  return (
    <main className="min-h-screen bg-deep-ink px-4 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <PublicBookingPage
          token={token}
          businessName={context.businessName}
          description={context.description}
          allowedDurations={context.allowedDurations}
          videoCall={context.videoCall}
          sendsInvite={context.mode === "provider"}
          locale={locale}
          intakeQuestions={activeIntakeQuestions(parseIntakeQuestions(context.page.intake_questions))}
          strings={{
            eventTitle: context.title ?? t("eventTitle", { business: context.businessName }),
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
            intakePickOne: t("intakePickOne"),
            intakeAnswerRequired: t("intakeAnswerRequired"),
            notifyEarlierLabel: t("notifyEarlierLabel"),
            submitButton: t("submitButton"),
            submitting: t("submitting"),
            slotTaken: t("slotTaken"),
            alreadyBooked: t("alreadyBooked"),
            submitFailed: t("submitFailed"),
            checkDetails: t("checkDetails"),
            bookedHeading: t("bookedHeading"),
            bookedBody: t("bookedBody", { business: context.businessName }),
            bookedBodyNoInvite: t("bookedBodyNoInvite", { business: context.businessName }),
            bookedVideoNote: t("bookedVideoNote"),
            bookedZoomLinkLabel: t("bookedZoomLinkLabel"),
            bookedManageLinkLabel: t("bookedManageLinkLabel"),
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
