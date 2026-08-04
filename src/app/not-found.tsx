/**
 * The branded 404, covering EVERY not-found in the app: junk URLs, retired
 * marketing slugs, and each `notFound()` a route throws (expired capability
 * links included, so the copy allows for "your link may have expired", not
 * just "you typed it wrong"). Until this file existed, all of those landed
 * on Next's bare black default, which reads as "this site is broken".
 */
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { INLINE_LOGO_DATA_URI } from "@/app/inline-logo";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <main className="flex min-h-screen items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-md text-center">
        {/*
          Inlined on purpose, and the one place in the app that should be.
          Through `next/image` this logo cost two extra edge requests per 404
          (`/_next/image`, plus `/api/brand-logo` on an optimizer miss via the
          `beforeFiles` rewrite), which is what turned the Aug 3 2026 scrape
          into a 50x usage-anomaly alert. The bytes below are ~900 characters,
          so carrying them in the HTML is cheaper than the round trips, and it
          leaves the 404 with no dependency on the image optimizer at all.
          Regenerate with `npx tsx scripts/generate-inline-logo.ts`.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URI has nothing for next/image to optimize; that is the point. */}
        <img
          src={INLINE_LOGO_DATA_URI}
          alt="New Coworker"
          width={48}
          height={48}
          className="mx-auto rounded-full"
        />
        <h1 className="mt-6 text-2xl font-semibold text-parchment">{t("heading")}</h1>
        <p className="mt-3 text-sm text-parchment/60">{t("body")}</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md border border-parchment/25 px-4 py-2 text-sm text-parchment/80 transition-colors hover:border-parchment/50"
        >
          {t("homeCta")}
        </Link>
      </div>
    </main>
  );
}
