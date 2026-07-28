/**
 * The rendered booking surface, shared by the page link and every
 * meeting-type link.
 *
 * Both routes show the same two-panel booking UI; they differ only in
 * WHICH meeting is being booked. Extracted so the (long) localized string
 * set is built in exactly one place: a type link that drifted from the
 * page link would be the kind of bug nobody notices until a customer
 * reads it.
 */
import { getLocale, getTranslations } from "next-intl/server";
import { PublicBookingPage } from "@/components/booking/PublicBookingPage";
import { activeIntakeQuestions } from "@/lib/booking-page/intake";
import { effectiveTypeSettings, type BookingMeetingTypeRow } from "@/lib/booking-page/meeting-types";
import type { BookingPageContext } from "@/lib/booking-page/service";

export async function BookingSurface({
  token,
  context,
  meetingType
}: {
  /** The page ref exactly as the visitor typed it (token or vanity slug). */
  token: string;
  context: BookingPageContext;
  /** The meeting being booked, or null for the page's own flow. */
  meetingType: BookingMeetingTypeRow | null;
}) {
  const t = await getTranslations("bookingPage");
  const locale = await getLocale();
  const effective = effectiveTypeSettings(
    context.page,
    meetingType,
    context.allowedDurations[0]
  );

  return (
    <PublicBookingPage
      token={token}
      businessName={context.businessName}
      description={effective.description}
      // A meeting type owns its length, so the picker collapses to it.
      allowedDurations={meetingType ? [meetingType.duration_minutes] : context.allowedDurations}
      videoCall={context.videoCall}
      sendsInvite={context.mode === "provider"}
      locale={locale}
      intakeQuestions={activeIntakeQuestions(effective.questions)}
      meetingTypeSlug={meetingType?.slug ?? null}
      strings={{
        eventTitle: effective.title ?? t("eventTitle", { business: context.businessName }),
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
  );
}

/**
 * The branded "this link does not work" screen. A well-formed link that
 * does not resolve was handed out by the business, so a bare 404 reads as
 * "this business is broken"; each cause gets its own honest sentence.
 */
export async function BookingUnavailable({
  reason
}: {
  reason: "disabled" | "provider" | "meeting";
}) {
  const t = await getTranslations("bookingPage");
  const body =
    reason === "provider"
      ? t("unavailableProviderBody")
      : reason === "meeting"
        ? t("unavailableMeetingBody")
        : t("unavailableBody");
  return (
    <div className="mx-auto w-full max-w-lg pt-16 text-center">
      <h1 className="text-xl font-semibold text-parchment">{t("unavailableHeading")}</h1>
      <p className="mt-3 rounded-md border border-spark-orange/40 bg-spark-orange/10 px-4 py-3 text-sm text-spark-orange">
        {body}
      </p>
    </div>
  );
}
