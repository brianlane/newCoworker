"use client";

/**
 * Persistent dashboard banner while a stored grant needs reconnect.
 * Calendly keeps CalendlyReauthBanner; this one covers Zoom, Google,
 * Microsoft 365, Acuity, CalDAV, Vagaro, Facebook, Slack, and WhatsApp.
 * Not a modal: it stays until that connection is healthy again.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

type ConnectionReauthBannerItem = {
  id: string;
  provider: string;
  accountLabel: string;
  lastHealthyLabel: string | null;
  reconnectPath: string;
  pausedWork: string;
};

type Props = {
  banners: ConnectionReauthBannerItem[];
};

export function ConnectionReauthBanner({ banners }: Props) {
  const t = useTranslations("dashboard.connectionReauth");
  if (banners.length === 0) return null;

  return (
    <div className="mb-6 space-y-3">
      {banners.map((banner) => {
        const body = banner.lastHealthyLabel
          ? t("bodyWithLastCheck", {
              account: banner.accountLabel,
              provider: banner.provider,
              pausedWork: banner.pausedWork,
              when: banner.lastHealthyLabel
            })
          : t("bodyNoLastCheck", {
              account: banner.accountLabel,
              provider: banner.provider,
              pausedWork: banner.pausedWork
            });
        return (
          <div
            key={`${banner.provider}:${banner.id}`}
            className="flex flex-col gap-3 rounded-lg border border-spark-orange/40 bg-spark-orange/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-spark-orange">
                {t("title", { provider: banner.provider })}
              </p>
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
