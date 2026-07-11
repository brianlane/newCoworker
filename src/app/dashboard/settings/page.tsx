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
import { Card } from "@/components/ui/Card";
import { loadSettingsContext } from "./_shared";

export const dynamic = "force-dynamic";

/**
 * Settings hub (BizBlasts-style): a navigation grid of category cards, each
 * opening its own settings page. One flat, ordered list — Danger Zone is
 * deliberately the LAST card so destructive actions sit at the bottom of
 * the page.
 */
type HubEntry = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  enterpriseOnly?: boolean;
  danger?: boolean;
  /** Muted icon treatment for shortcuts that live outside the settings tree. */
  shortcut?: boolean;
};

const HUB_ENTRIES: HubEntry[] = [
  {
    href: "/dashboard/settings/account",
    title: "Account",
    description: "Plan, billing summary, login email, and password",
    icon: User
  },
  {
    href: "/dashboard/settings/business",
    title: "Business",
    description: "Name, timezone, owner contact, address, industry, and opening hours",
    icon: Building2
  },
  {
    href: "/dashboard/settings/coworker",
    title: "Coworker",
    description: "AI mailbox, enabled tools, and flow safety behavior",
    icon: Bot
  },
  {
    href: "/dashboard/settings/channels",
    title: "Channels",
    description: "Website chat widget, phone number, notifications, and text opt-outs",
    icon: Radio
  },
  {
    href: "/dashboard/settings/team",
    title: "Team",
    description: "Dashboard access, white-label branding, and dedicated support",
    icon: Users,
    enterpriseOnly: true
  },
  {
    href: "/dashboard/settings/sidebar",
    title: "Sidebar",
    description: "Reorder the navigation and hide pages you don't use",
    icon: PanelLeft
  },
  {
    href: "/dashboard/settings/number",
    title: "Bring your own number",
    description: "Transfer an existing business number to your coworker",
    icon: Phone,
    shortcut: true
  },
  {
    href: "/dashboard/notifications",
    title: "Notifications",
    description: "Alert channels, categories, and delivery history",
    icon: Bell,
    shortcut: true
  },
  {
    href: "/dashboard/settings/danger",
    title: "Danger Zone",
    description: "Sign out everywhere or permanently delete your account",
    icon: AlertTriangle,
    danger: true
  }
];

export default async function SettingsHubPage() {
  const ctx = await loadSettingsContext();
  const isEnterprise = ctx.business?.tier === "enterprise";
  const entries = HUB_ENTRIES.filter((e) => !e.enterpriseOnly || isEnterprise);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Settings</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Manage your account, business profile, coworker behavior, and channels
        </p>
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
                      {entry.title}
                    </h2>
                    <p className="text-xs text-parchment/40 mt-1">{entry.description}</p>
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
