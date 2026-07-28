/**
 * One meeting's booking page (/book/<page>/<typeSlug>), the link an owner
 * actually shares: "here's my discovery call".
 *
 * It renders that meeting ALONE. No picker, no list, no hint that other
 * meeting types exist, exactly like a Calendly event link. That is the
 * point of the separate route: sharing a discovery-call link must never
 * expose the rest of the catalog, and a hidden ("secret") type is
 * reachable here while staying off the page's menu.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parseBookingPageRef, parseBookingPageSlug } from "@/lib/booking-page/keys";
import { getBookingPageContext } from "@/lib/booking-page/service";
import { BookingSurface, BookingUnavailable } from "@/components/booking/BookingSurface";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("bookingPage");
  return { title: t("metaTitle"), robots: { index: false } };
}

export default async function BookMeetingTypePage({
  params
}: {
  params: Promise<{ token: string; typeSlug: string }>;
}) {
  const { token, typeSlug } = await params;
  // Both segments fail closed on shape before any DB hit.
  if (!parseBookingPageRef(token) || !parseBookingPageSlug(typeSlug)) notFound();

  const resolved = await getBookingPageContext(token);

  const shell = (children: React.ReactNode) => (
    <main className="min-h-screen bg-deep-ink px-4 py-10">
      <div className="mx-auto w-full max-w-4xl">{children}</div>
    </main>
  );

  if (!resolved.ok) {
    return shell(
      <BookingUnavailable
        reason={resolved.detail === "calendar_not_connected" ? "provider" : "disabled"}
      />
    );
  }
  const { context } = resolved;

  // Hidden types resolve here (that is what hidden means); disabled and
  // unknown ones do not, and both get the same answer so a direct link can
  // never be used to probe what a business offers.
  const meetingType = context.meetingTypes.find((t) => t.slug === typeSlug && t.enabled);
  if (!meetingType) return shell(<BookingUnavailable reason="meeting" />);

  return shell(
    <BookingSurface token={token} context={context} meetingType={meetingType} />
  );
}
