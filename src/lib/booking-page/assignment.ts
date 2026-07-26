/**
 * Who a public-page booking is for.
 *
 * Three modes, and the difference is visible to the visitor as availability:
 *
 * - `any`: the business as a whole (what every page did before this). No
 *   assignee is recorded, and availability is whole-business.
 * - `round_robin`: the active roster shares the page. Availability is the
 *   union of their shifts, and each booking names whoever picks it up.
 * - `fixed`: one employee's page. Availability is THEIR shift, so a visitor
 *   can only take time that person actually has.
 *
 * The choice itself is pure (`chooseAssignee`) so the fairness rule is
 * readable and testable without a database: fewest upcoming bookings first,
 * then whoever has waited longest, then a stable id tiebreak. Counting real
 * bookings rather than just rotating means a cancellation-heavy week
 * self-corrects instead of compounding.
 */

import type { TeamMemberRow, TimeOffRow } from "@/lib/db/employees";
import {
  isWithinWeeklyWindows,
  localClock,
  parseWeeklyWindows
} from "../../../supabase/functions/_shared/ai_flows/engine";

export type AssignmentMode = "any" | "round_robin" | "fixed";

/** Anything unrecognized reads as `any`: the safe, pre-existing behavior. */
export function parseAssignmentMode(raw: unknown): AssignmentMode {
  return raw === "round_robin" || raw === "fixed" ? raw : "any";
}

/**
 * The members a page can book, before availability is considered.
 *
 * A `fixed` page whose employee is gone or deactivated falls back to the
 * whole roster rather than showing no times at all: an owner discovers a
 * stale setting from bookings landing oddly, not from a dead page.
 */
export function eligibleMembers(
  mode: AssignmentMode,
  employeeId: string | null,
  roster: TeamMemberRow[]
): TeamMemberRow[] {
  const active = roster.filter((m) => m.active);
  if (mode === "any") return active;
  if (mode === "fixed") {
    const one = active.filter((m) => m.id === employeeId);
    return one.length > 0 ? one : active;
  }
  return active;
}

/** Is this member working at that instant, and not on time off? */
export function memberAvailableAt(
  member: TeamMemberRow,
  timeOff: TimeOffRow[],
  startIso: string,
  timezone: string
): boolean {
  const clock = localClock(new Date(startIso), timezone);
  const off = timeOff.some(
    (t) => t.member_id === member.id && t.starts_on <= clock.isoDate && clock.isoDate <= t.ends_on
  );
  if (off) return false;
  const windows = parseWeeklyWindows(member.weekly_schedule);
  // No usable schedule counts as always on shift, matching how the roster
  // filter treats it everywhere else.
  return windows === null || isWithinWeeklyWindows(windows, clock);
}

export type AssigneeChoice = {
  memberId: string | null;
  /** Why, for the log when a booking lands unassigned. */
  reason: "unassigned_mode" | "chosen" | "nobody_available";
};

/**
 * Pick who gets a booking at `startIso`.
 *
 * `upcomingCounts` is each member's current upcoming load, so the fairness
 * rule is "least loaded", not "next in line": a member whose day emptied out
 * to cancellations is picked before one who is already full.
 */
export function chooseAssignee(input: {
  mode: AssignmentMode;
  employeeId: string | null;
  roster: TeamMemberRow[];
  timeOff: TimeOffRow[];
  startIso: string;
  timezone: string;
  upcomingCounts: Map<string, number>;
}): AssigneeChoice {
  if (input.mode === "any") return { memberId: null, reason: "unassigned_mode" };

  const candidates = eligibleMembers(input.mode, input.employeeId, input.roster).filter((m) =>
    memberAvailableAt(m, input.timeOff, input.startIso, input.timezone)
  );
  if (candidates.length === 0) return { memberId: null, reason: "nobody_available" };

  const best = candidates.slice().sort((a, b) => {
    const load = (input.upcomingCounts.get(a.id) ?? 0) - (input.upcomingCounts.get(b.id) ?? 0);
    if (load !== 0) return load;
    // Whoever has waited longest; never offered at all waits longest.
    const aWait = a.last_offered_at ? Date.parse(a.last_offered_at) : 0;
    const bWait = b.last_offered_at ? Date.parse(b.last_offered_at) : 0;
    if (aWait !== bWait) return aWait - bWait;
    // Stable, so the same inputs always name the same person.
    return a.id.localeCompare(b.id);
  })[0];

  return { memberId: best.id, reason: "chosen" };
}
