"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/ui/Sidebar";
import {
  LayoutDashboard,
  MessageSquare,
  Phone,
  MessageCircle,
  Brain,
  Plug,
  Settings,
  Bell,
  Users,
  UserCog,
  Workflow,
  CreditCard
} from "lucide-react";

const ownerNavItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Chat", href: "/dashboard/chat", icon: MessageSquare },
  { label: "Calls", href: "/dashboard/calls", icon: Phone },
  { label: "Texts", href: "/dashboard/messages", icon: MessageCircle },
  // Cross-channel customers view (Phase 4 of the customer memory plan):
  // unified per-customer profile across SMS + voice. Sits between the
  // channel-specific dashboards and the business-level Memory page so
  // owners can find a person without remembering which channel they
  // came in on.
  { label: "Customers", href: "/dashboard/customers", icon: Users },
  // Team roster shared with AiFlow route_to_team: who leads rotate through,
  // their schedules/preferred times, and time off (which supersedes routing).
  { label: "Employees", href: "/dashboard/employees", icon: UserCog },
  { label: "Memory", href: "/dashboard/memory", icon: Brain },
  { label: "Integrations", href: "/dashboard/integrations", icon: Plug },
  { label: "AiFlows", href: "/dashboard/aiflows", icon: Workflow },
  { label: "Billing", href: "/dashboard/billing", icon: CreditCard },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
  { label: "Notifications", href: "/dashboard/notifications", icon: Bell }
];

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
  businessId
}: {
  userEmail?: string | null;
  businessId?: string | null;
}) {
  const unread = useUnreadNotificationCount(businessId ?? null);

  return (
    <Sidebar
      items={ownerNavItems}
      userEmail={userEmail}
      renderTrailing={(item) => {
        if (item.href !== "/dashboard/notifications") return null;
        if (unread <= 0) return null;
        return (
          <span
            data-testid="sidebar-unread-badge"
            className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-spark-orange px-1.5 py-0.5 text-[10px] font-semibold leading-none text-deep-ink"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        );
      }}
    />
  );
}
