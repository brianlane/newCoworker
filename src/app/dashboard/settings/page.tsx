import Link from "next/link";
import {
  User,
  Building2,
  Bot,
  Radio,
  Users,
  Phone,
  Bell,
  PanelLeft,
  AlertTriangle,
  ChevronRight,
  type LucideIcon
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { loadSettingsContext } from "./_shared";

export const dynamic = "force-dynamic";

/**
 * Settings hub (BizBlasts-style): a navigation grid of category cards, each
 * opening its own settings page. One flat, ordered list — Danger Zone is
 * deliberately the LAST card so destructive actions sit at the bottom of
 * the page. Copy lives under `dashboard.settings.hub*` in the catalogs.
 */
type HubEntry = {
  href: string;
  titleKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  enterpriseOnly?: boolean;
  danger?: boolean;
  /** Muted icon treatment for shortcuts that live outside the settings tree. */
  shortcut?: boolean;
};

const HUB_ENTRIES: HubEntry[] = [
  {
    href: "/dashboard/settings/account",
    titleKey: "accountTitle",
    descriptionKey: "hubAccountBlurb",
    icon: User
  },
  {
    href: "/dashboard/settings/business",
    titleKey: "hubBusinessTitle",
    descriptionKey: "hubBusinessBlurb",
    icon: Building2
  },
  {
    href: "/dashboard/settings/coworker",
    titleKey: "hubCoworkerTitle",
    descriptionKey: "hubCoworkerBlurb",
    icon: Bot
  },
  {
    href: "/dashboard/settings/channels",
    titleKey: "hubChannelsTitle",
    descriptionKey: "hubChannelsBlurb",
    icon: Radio
  },
  {
    href: "/dashboard/settings/team",
    titleKey: "hubTeamTitle",
    descriptionKey: "hubTeamBlurb",
    icon: Users,
    enterpriseOnly: true
  },
  {
    href: "/dashboard/settings/sidebar",
    titleKey: "hubSidebarTitle",
    descriptionKey: "hubSidebarBlurb",
    icon: PanelLeft
  },
  {
    href: "/dashboard/settings/number",
    titleKey: "hubNumberTitle",
    descriptionKey: "hubNumberBlurb",
    icon: Phone,
    shortcut: true
  },
  {
    href: "/dashboard/notifications",
    titleKey: "hubNotificationsTitle",
    descriptionKey: "hubNotificationsBlurb",
    icon: Bell,
    shortcut: true
  },
  {
    href: "/dashboard/settings/danger",
    titleKey: "hubDangerTitle",
    descriptionKey: "hubDangerBlurb",
    icon: AlertTriangle,
    danger: true
  }
];

export default async function SettingsHubPage() {
  const t = await getTranslations("dashboard.settings");
  const ctx = await loadSettingsContext();
  const isEnterprise = ctx.business?.tier === "enterprise";
  const entries = HUB_ENTRIES.filter((e) => !e.enterpriseOnly || isEnterprise);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("hubTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">{t("hubSubtitle")}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <Link key={entry.href} href={entry.href} className="block group">
              <Card
                className={`h-full transition-colors cursor-pointer ${
                  entry.danger
                    ? "hover:border-spark-orange/50"
                    : "hover:border-signal-teal/50"
                }`}
              >
                <div className="flex items-start gap-4">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                      entry.danger
                        ? "bg-spark-orange/10 text-spark-orange"
                        : entry.shortcut
                          ? "bg-parchment/5 text-parchment/60"
                          : "bg-signal-teal/10 text-signal-teal"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2
                      className={`text-sm font-semibold ${
                        entry.danger
                          ? "text-parchment group-hover:text-spark-orange"
                          : "text-parchment group-hover:text-signal-teal"
                      } transition-colors`}
                    >
                      {t(entry.titleKey)}
                    </h2>
                    <p className="text-xs text-parchment/40 mt-1">{t(entry.descriptionKey)}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-parchment/25 group-hover:text-parchment/60 group-hover:translate-x-0.5 transition-all mt-0.5" />
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
