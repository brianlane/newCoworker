import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

export const dynamic = "force-dynamic";

/**
 * Human-facing unsubscribe result page. The actual unsubscribe happens in
 * /api/blog/unsubscribe (which also serves RFC 8058 one-click POSTs) and
 * redirects here with ?ok=1|0.
 */
export default async function BlogUnsubscribePage({
  searchParams
}: {
  searchParams: Promise<{ ok?: string }>;
}) {
  const t = await getTranslations("marketing.blogPage");
  const { ok } = await searchParams;
  const state = ok === "1" ? "done" : ok === "retry" ? "retry" : "invalid";
  const title =
    state === "done"
      ? t("unsubscribeTitle")
      : state === "retry"
        ? t("unsubscribeRetryTitle")
        : t("unsubscribeInvalidTitle");
  const body =
    state === "done"
      ? t("unsubscribeBody")
      : state === "retry"
        ? t("unsubscribeRetryBody")
        : t("unsubscribeInvalidBody");

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />
      <section className="mx-auto max-w-xl px-6 py-24 text-center">
        <h1 className="text-3xl font-bold text-parchment">{title}</h1>
        <p className="mt-4 text-parchment/60">{body}</p>
        <Link href="/blog" className="mt-8 inline-block text-signal-teal hover:underline">
          ← {t("backToBlog")}
        </Link>
      </section>
      <MarketingFooter />
    </div>
  );
}
