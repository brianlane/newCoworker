"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sidebar } from "@/components/ui/Sidebar";
import { SIDEBAR_ITEMS } from "@/lib/dashboard/sidebar-items";
import type { SidebarLayoutItem } from "@/lib/dashboard/sidebar-prefs";
import {
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Phone,
  MessageCircle,
  Mail,
  Brain,
  Plug,
  Settings,
  Bell,
  Users,
  UserCog,
  Workflow,
  Bot,
  CreditCard,
  ArrowDownUp,
  BarChart3,
  Globe,
  MessageCircleMore,
  MessagesSquare,
  Megaphone,
  type LucideIcon
} from "lucide-react";

/**
 * Icons keyed by the catalog keys in src/lib/dashboard/sidebar-items.ts —
 * labels/hrefs/ordering live there (shared with the per-user customization
 * prefs); only the visual layer stays in this client component.
 */
const NAV_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  tasks: ListChecks,
  analytics: BarChart3,
  chat: MessageSquare,
  calls: Phone,
  messages: MessageCircle,
  messenger: MessagesSquare,
  whatsapp: MessageCircleMore,
  webchat: Globe,
  emails: Mail,
  customers: Users,
  employees: UserCog,
  memory: Brain,
  marketing: Megaphone,
  "import-export": ArrowDownUp,
  integrations: Plug,
  aiflows: Workflow,
  agents: Bot,
  billing: CreditCard,
  settings: Settings,
  notifications: Bell
};

const defaultNavItems = SIDEBAR_ITEMS.map((item) => ({
  labelKey: item.labelKey,
  href: item.href,
  icon: NAV_ICONS[item.key] ?? LayoutDashboard
}));

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls /api/notifications/unread-count for the bell badge. Backed by a
 * partial index so the cost per poll is O(unread). The poll cadence is
 * deliberately conservative (60s) — we'd rather be a few seconds stale
 * than spam Postgres on every dashboard tab.
 */
function useUnreadNotificationCount(businessId: string | null): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!businessId) {
      // Clearing the count when there's no business is handled by the next
      // effect run not running setCount, so we just bail. The previous render
      // already produced count = 0 (initial state) or stale-but-harmless data
      // from a prior business.
      return;
    }
    let cancelled = false;
    let lastFetchedAt = 0;
    const fetchCount = async () => {
      lastFetchedAt = Date.now();
      try {
        const res = await fetch(
          `/api/notifications/unread-count?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const json = (await res.json()) as { ok: boolean; data?: { count: number } };
        if (!cancelled && json.ok && typeof json.data?.count === "number") {
          setCount(json.data.count);
        }
      } catch {
        // Network errors are non-fatal — we'll retry on the next tick.
      }
    };
    void fetchCount();
    // Re-fetch on focus so a user who marked something read in another tab
    // doesn't have to wait the full poll interval to see the badge update.
    // Debounced: each poll hits getClaims (proxy) + getAuthUser + requireOwner
    // + the count query, so an owner who keeps many dashboard tabs open and
    // alt-tabs between them would otherwise fire a burst of 4-call cycles on
    // every focus. Skip the focus refetch if we polled within the last 15s.
    const FOCUS_REFETCH_MIN_GAP_MS = 15_000;
    const onFocus = () => {
      if (Date.now() - lastFetchedAt >= FOCUS_REFETCH_MIN_GAP_MS) {
        void fetchCount();
      }
    };
    window.addEventListener("focus", onFocus);
    const handle = window.setInterval(fetchCount, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      window.removeEventListener("focus", onFocus);
    };
  }, [businessId]);

  // When businessId is null, we always want to show 0. Avoid a setState-in-effect
  // by deriving directly from the dependency.
  return businessId ? count : 0;
}

export function DashboardSidebar({
  userEmail,
  businessId,
  brand,
  layout
}: {
  userEmail?: string | null;
  businessId?: string | null;
  /** White-label branding (enterprise); null/undefined = platform branding. */
  brand?: import("@/components/ui/Sidebar").SidebarBrand | null;
  /** Per-user layout (order + visibility); omitted = default catalog order. */
  layout?: SidebarLayoutItem[] | null;
}) {
  const tNav = useTranslations("dashboard.nav");
  const unread = useUnreadNotificationCount(businessId ?? null);

  const rawItems = layout
    ? layout
        .filter((item) => item.visible)
        .map((item) => ({
          labelKey: item.labelKey,
          href: item.href,
          icon: NAV_ICONS[item.key] ?? LayoutDashboard
        }))
    : defaultNavItems;

  const items = rawItems.map((item) => ({
    label: tNav(item.labelKey),
    href: item.href,
    icon: item.icon
  }));

  return (
    <Sidebar
      items={items}
      userEmail={userEmail}
      brand={brand}
      renderTrailing={(item) => {
        if (item.href !== "/dashboard/notifications") return null;
        if (unread <= 0) return null;
        return (
          <span
            data-testid="sidebar-unread-badge"
            className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-signal-teal px-1.5 py-0.5 text-[10px] font-semibold leading-none text-deep-ink"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        );
      }}
    />
  );
}
