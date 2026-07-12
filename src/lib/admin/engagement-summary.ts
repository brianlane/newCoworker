/**
 * Pure DAU/WAU/MAU summary over the auth directory — split from
 * user-engagement.ts so the client-side KPI component (which must compute
 * "today" in the VIEWER's timezone) can import it without dragging the
 * server-only Supabase client into the browser bundle.
 */

/** One Supabase auth user, as read from `auth.admin.listUsers()`. */
export type PlatformAuthUser = {
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type UserEngagementSummary = {
  totalUsers: number;
  activeToday: number;
  active7d: number;
  active30d: number;
  /** BizBlasts' "Daily Engagement Rate": active today ÷ total users. */
  dailyEngagementRatePct: number;
};

/** Calendar-day key (YYYY-MM-DD) in `timeZone`, or the runtime's zone when omitted. */
function dayKey(at: Date, timeZone?: string): string {
  return at.toLocaleDateString("en-CA", timeZone ? { timeZone } : undefined);
}

/**
 * DAU / WAU / MAU over the auth directory (one count per auth user).
 *
 * "Active today" is a CALENDAR-day match (BizBlasts DAU semantics: signed in
 * on today's date), not a rolling 24-hour window — a sign-in yesterday
 * evening must not read as "active today" the next morning. Pass `timeZone`
 * to pin the day boundary (tests use "UTC"; the KPI component omits it so
 * the viewer's local midnight wins). The 7/30-day counts stay rolling
 * windows.
 */
export function summarizeUserEngagement(
  users: PlatformAuthUser[],
  now: Date = new Date(),
  timeZone?: string
): UserEngagementSummary {
  const todayKey = dayKey(now, timeZone);
  let activeToday = 0;
  let active7d = 0;
  let active30d = 0;
  for (const user of users) {
    const last = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN;
    if (!Number.isFinite(last)) continue;
    if (dayKey(new Date(last), timeZone) === todayKey) activeToday += 1;
    const age = now.getTime() - last;
    if (age <= 7 * DAY_MS) active7d += 1;
    if (age <= 30 * DAY_MS) active30d += 1;
  }
  return {
    totalUsers: users.length,
    activeToday,
    active7d,
    active30d,
    dailyEngagementRatePct:
      users.length > 0 ? Math.round((activeToday / users.length) * 100) : 0
  };
}
