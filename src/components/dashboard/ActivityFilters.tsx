"use client";

import { useRouter } from "next/navigation";
import { ACTIVITY_BADGE } from "@/components/dashboard/activity-badge";
import { ACTIVITY_KINDS, type ActivityKind } from "@/lib/db/activity";

/** Preset look-backs offered by the time filter, longest first trimmed to the
 * tier window (a starter tenant is never offered "Last 30 days"). */
const DAY_PRESETS = [1, 7, 30] as const;

/**
 * Filter bar for the full "See all activity" page: toggle chips for each
 * activity kind (no chips selected = everything) plus a look-back preset
 * select. The state lives in the URL (`kinds`, `days`) — changing either
 * navigates to a cursor-less URL so the server refetches the newest chunk of
 * the filtered view, and the chunk pager links carry the params along.
 */
export function ActivityFilters({
  kinds,
  days,
  windowDays
}: {
  /** Currently selected kinds (validated server-side); empty = all. */
  kinds: ActivityKind[];
  /** Current look-back in days; undefined = the full tier window. */
  days: number | undefined;
  /** The tier's maximum window — presets at/above it collapse into "All". */
  windowDays: number;
}) {
  const router = useRouter();

  const navigate = (nextKinds: ActivityKind[], nextDays: number | undefined) => {
    const q = new URLSearchParams();
    if (nextKinds.length > 0) q.set("kinds", nextKinds.join(","));
    if (nextDays) q.set("days", String(nextDays));
    const qs = q.toString();
    router.push(qs ? `/dashboard/activity?${qs}` : "/dashboard/activity");
  };

  const toggleKind = (kind: ActivityKind) => {
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    navigate(next, days);
  };

  const presets = DAY_PRESETS.filter((d) => d < windowDays);
  // A days value not in the presets (hand-edited URL) still renders selected
  // so the select reflects what the list actually shows.
  const extraDays = days !== undefined && !presets.includes(days as 1 | 7 | 30) ? days : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by type">
        {ACTIVITY_KINDS.map((kind) => {
          const active = kinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => toggleKind(kind)}
              aria-pressed={active}
              className={[
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-signal-teal/70 bg-signal-teal/15 text-signal-teal"
                  : "border-parchment/15 text-parchment/60 hover:border-parchment/35 hover:text-parchment"
              ].join(" ")}
            >
              {ACTIVITY_BADGE[kind].label}
            </button>
          );
        })}
        {kinds.length > 0 && (
          <button
            type="button"
            onClick={() => navigate([], days)}
            className="px-1.5 py-1 text-xs text-parchment/40 hover:text-parchment transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <label htmlFor="activity-days" className="text-xs text-parchment/50">
          Time
        </label>
        <select
          id="activity-days"
          value={days ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            navigate(kinds, raw === "" ? undefined : Number(raw));
          }}
          className="rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment focus:border-signal-teal/60 focus:outline-none"
        >
          {presets.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? "Today" : `Last ${d} days`}
            </option>
          ))}
          {extraDays !== null && (
            <option value={extraDays}>
              Last {Math.min(extraDays, windowDays)} days
            </option>
          )}
          <option value="">Last {windowDays} days (all)</option>
        </select>
      </div>
    </div>
  );
}
