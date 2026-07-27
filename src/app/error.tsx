"use client";

/**
 * The branded error screen for genuine server failures (the 500 class),
 * completing the pair with `not-found.tsx`: before this file existed, a
 * crashed page rendered the platform's raw "This page couldn't load"
 * screen, unbranded and dead-ended. Client component by Next's contract,
 * with the reset() retry it hands us wired to the button.
 */
import Image from "next/image";
import { useEffect } from "react";
import { useTranslations } from "next-intl";

export default function ErrorPage({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  useEffect(() => {
    // Server logs carry the real stack; this ties the user's report ("I got
    // an error page") to it via the digest.
    console.error("page error boundary", error.digest ?? error.message);
  }, [error]);

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
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-block rounded-md border border-parchment/25 px-4 py-2 text-sm text-parchment/80 transition-colors hover:border-parchment/50"
        >
          {t("retryCta")}
        </button>
        {error.digest ? (
          <p className="mt-4 text-xs text-parchment/30">{t("digest", { digest: error.digest })}</p>
        ) : null}
      </div>
    </main>
  );
}
