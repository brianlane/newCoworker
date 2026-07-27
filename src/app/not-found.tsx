/**
 * The branded 404, covering EVERY not-found in the app: junk URLs, retired
 * marketing slugs, and each `notFound()` a route throws (expired capability
 * links included, so the copy allows for "your link may have expired", not
 * just "you typed it wrong"). Until this file existed, all of those landed
 * on Next's bare black default, which reads as "this site is broken".
 */
import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <main className="flex min-h-screen items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-md text-center">
        <Image
          src="/logo.png"
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
