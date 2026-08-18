/**
 * Public self-serve booking page, the durable, shareable link
 * (/book/<ncb_token>) a business hands to anyone who should book time on
 * its calendar. Fully public by design (no login, no account): the
 * unguessable capability token is the only credential, exactly like the
 * white-glove intake link. Layout mirrors the familiar two-panel booking
 * pages (business panel left, calendar and times right).
 *
 * With meeting types defined, this link is the MENU: it lists the visible
 * ones and each goes to its own /book/<page>/<typeSlug> page. One visible
 * type skips the menu (a picker of one is a dead click), and zero types is
 * the original single-calendar flow.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parseBookingPageRef } from "@/lib/booking-page/keys";
import { getBookingPageContext } from "@/lib/booking-page/service";
import { visibleMeetingTypes } from "@/lib/booking-page/meeting-types";
import { BookingSurface, BookingUnavailable } from "@/components/booking/BookingSurface";

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

  const shell = (children: React.ReactNode) => (
    <main className="min-h-screen bg-deep-ink px-4 py-10">
      <div className="mx-auto w-full max-w-4xl">{children}</div>
    </main>
  );

  if (!resolved.ok) {
    // A Vagaro/Calendly-resolved tenant (calendar_not_connected) books on
    // their provider's own page, which is not the same as Live being off.
    return shell(
      <BookingUnavailable
        reason={resolved.detail === "calendar_not_connected" ? "provider" : "disabled"}
      />
    );
  }
  const { context } = resolved;
  const visible = visibleMeetingTypes(context.meetingTypes);

  // Zero types is the original flow; exactly one goes straight to it.
  if (visible.length <= 1) {
    return shell(
      <BookingSurface token={token} context={context} meetingType={visible[0] ?? null} />
    );
  }

  return shell(
    <div className="rounded-lg border border-parchment/15 bg-ink-800/60 p-6">
      <p className="text-xs uppercase tracking-wider text-parchment/40">
        {context.businessName}
      </p>
      <h1 className="mt-2 text-xl font-bold text-parchment">{t("pickMeetingHeading")}</h1>
      <p className="mt-1 text-sm text-parchment/60">{t("pickMeetingSubtitle")}</p>
      <ul className="mt-5 space-y-3">
        {visible.map((type) => (
          <li key={type.id}>
            <Link
              href={`/book/${token}/${type.slug}`}
              className="block rounded-md border border-parchment/20 p-4 transition-colors hover:border-claw-green/60"
            >
              <span className="block text-base font-semibold text-parchment">{type.name}</span>
              <span className="mt-1 block text-sm text-parchment/50">
                {type.duration_minutes} {t("durationMinutes")}
              </span>
              {type.description ? (
                <span className="mt-2 block text-sm leading-relaxed text-parchment/70">
                  {type.description}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-xs text-parchment/30">{t("poweredBy")}</p>
    </div>
  );
}
