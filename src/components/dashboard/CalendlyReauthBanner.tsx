"use client";

/**
 * Persistent dashboard banner while a Calendly PAT needs reconnect.
 * Not a modal: it stays until the connection is healthy again. Reconnect
 * deep-links into the existing paste-token form on THAT connection row.
 *
 * Last-check is formatted here (browser local timezone) so it agrees with
 * the connections card. The server passes the ISO stamp, not a UTC label.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { formatCalendlyLastHealthy } from "@/lib/calendly/reauth-copy";

type CalendlyReauthBannerItem = {
  id: string;
  accountLabel: string;
  lastHealthyAt: string | null;
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
        const lastHealthyLabel = formatCalendlyLastHealthy(banner.lastHealthyAt);
        const body = lastHealthyLabel
          ? t("bodyWithLastCheck", {
              account: banner.accountLabel,
              when: lastHealthyLabel
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
