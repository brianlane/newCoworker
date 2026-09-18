"use client";

/**
 * Persistent dashboard banner while a Calendly PAT needs reconnect.
 * Not a modal: it stays until the connection is healthy again. Reconnect
 * deep-links into the existing paste-token form on THAT connection row.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

export type CalendlyReauthBannerItem = {
  id: string;
  accountLabel: string;
  lastHealthyLabel: string | null;
  reconnectPath: string;
};

type Props = {
  banners: CalendlyReauthBannerItem[];
};

export function CalendlyReauthBanner({ banners }: Props) {
  const t = useTranslations("dashboard.calendlyReauth");
  if (banners.length === 0) return null;

  return (
    <div className="mb-6 space-y-3">
      {banners.map((banner) => {
        const body = banner.lastHealthyLabel
          ? t("bodyWithLastCheck", {
              account: banner.accountLabel,
              when: banner.lastHealthyLabel
            })
          : t("bodyNoLastCheck", { account: banner.accountLabel });
        return (
          <div
            key={banner.id}
            className="flex flex-col gap-3 rounded-lg border border-spark-orange/40 bg-spark-orange/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-spark-orange">{t("title")}</p>
              <p className="mt-1 text-sm text-parchment/80">{body}</p>
            </div>
            <Link href={banner.reconnectPath} className="shrink-0">
              <Button type="button" variant="secondary" size="sm">
                {t("reconnect")}
              </Button>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
