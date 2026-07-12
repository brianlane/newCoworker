"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Card } from "@/components/ui/Card";
import {
  summarizeUserEngagement,
  type PlatformAuthUser
} from "@/lib/admin/engagement-summary";

const emptySubscribe = () => () => {};

/** False during SSR/hydration, true after (see LocalDateTime for rationale). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/**
 * The DAU/WAU/MAU KPI row, computed client-side so "Active Today" means the
 * VIEWER's calendar day — the server's UTC midnight would count a late-
 * evening local sign-in as "today" the next morning. Pre-hydration renders
 * pin the day boundary to UTC so server and first client markup match; the
 * hydration flip re-computes in the local zone.
 */
export function EngagementKpis({
  users,
  quietOwnerCount,
  quietRowCount
}: {
  users: PlatformAuthUser[];
  quietOwnerCount: number | null;
  quietRowCount: number;
}) {
  const hydrated = useHydrated();
  const summary = useMemo(
    () => summarizeUserEngagement(users, new Date(), hydrated ? undefined : "UTC"),
    [users, hydrated]
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Active Today</p>
        <p className="text-3xl font-bold text-parchment" suppressHydrationWarning>
          {summary.activeToday}
        </p>
        <p className="text-xs text-parchment/30 mt-1" suppressHydrationWarning>
          {summary.dailyEngagementRatePct}% of {summary.totalUsers} users
        </p>
      </Card>
      <Card>
        <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Active: 7 Days</p>
        <p className="text-3xl font-bold text-claw-green">{summary.active7d}</p>
      </Card>
      <Card>
        <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">Active: 30 Days</p>
        <p className="text-3xl font-bold text-signal-teal">{summary.active30d}</p>
      </Card>
      <Card>
        <p className="text-xs text-parchment/40 uppercase tracking-wider mb-1">
          Quiet Owners (90d+)
        </p>
        <p
          className={`text-3xl font-bold ${
            quietOwnerCount !== null && quietOwnerCount > 0
              ? "text-spark-orange"
              : "text-parchment"
          }`}
        >
          {quietOwnerCount ?? "–"}
        </p>
        <p className="text-xs text-parchment/30 mt-1">
          {quietOwnerCount === null
            ? "unknown — partial auth scan"
            : `churn-risk businesses · ${quietRowCount} quiet users total`}
        </p>
      </Card>
    </div>
  );
}
