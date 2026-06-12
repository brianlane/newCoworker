/**
 * Supabase access for the employees surface: the ai_flow_team_members
 * roster (shared with AiFlow route_to_team), employee_time_off ranges, and
 * per-employee routing stats aggregated from ai_flow_runs.
 *
 * Service-role only — owner authorization is the API route's job
 * (requireOwner before any call here), same trust model as the customers
 * routes.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type TeamMemberRow = {
  id: string;
  business_id: string;
  name: string;
  phone_e164: string;
  email: string | null;
  active: boolean;
  last_offered_at: string | null;
  /** Stored jsonb, shape {"mon":[["09:00","17:00"]]}. Unknown until validated. */
  weekly_schedule: unknown;
  /** Same shape as weekly_schedule; preferred lead-time windows. */
  preferred_windows: unknown;
  created_at: string;
};

export type TimeOffRow = {
  id: string;
  business_id: string;
  member_id: string;
  /** Inclusive YYYY-MM-DD range, interpreted in the business timezone. */
  starts_on: string;
  ends_on: string;
  note: string | null;
  created_at: string;
};

const MEMBER_COLUMNS =
  "id,business_id,name,phone_e164,email,active,last_offered_at," +
  "weekly_schedule,preferred_windows,created_at";

const TIME_OFF_COLUMNS = "id,business_id,member_id,starts_on,ends_on,note,created_at";

export async function listTeamMembers(
  businessId: string,
  client?: SupabaseClient
): Promise<TeamMemberRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flow_team_members")
    .select(MEMBER_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listTeamMembers: ${error.message}`);
  return (data ?? []) as unknown as TeamMemberRow[];
}

export type TeamMemberInput = {
  name: string;
  phoneE164: string;
  email?: string | null;
  weeklySchedule?: unknown;
  preferredWindows?: unknown;
};

export async function createTeamMember(
  businessId: string,
  input: TeamMemberInput,
  client?: SupabaseClient
): Promise<TeamMemberRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flow_team_members")
    .insert({
      business_id: businessId,
      name: input.name,
      phone_e164: input.phoneE164,
      email: input.email ?? null,
      weekly_schedule: input.weeklySchedule ?? null,
      preferred_windows: input.preferredWindows ?? null
    })
    .select(MEMBER_COLUMNS)
    .single();
  if (error) throw new Error(`createTeamMember: ${error.message}`);
  return data as unknown as TeamMemberRow;
}

export type TeamMemberPatch = {
  name?: string;
  phoneE164?: string;
  email?: string | null;
  active?: boolean;
  weeklySchedule?: unknown;
  preferredWindows?: unknown;
};

export async function updateTeamMember(
  businessId: string,
  memberId: string,
  patch: TeamMemberPatch,
  client?: SupabaseClient
): Promise<TeamMemberRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const row: Record<string, unknown> = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.phoneE164 !== undefined ? { phone_e164: patch.phoneE164 } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
    ...("weeklySchedule" in patch ? { weekly_schedule: patch.weeklySchedule ?? null } : {}),
    ...("preferredWindows" in patch ? { preferred_windows: patch.preferredWindows ?? null } : {})
  };
  const { data, error } = await db
    .from("ai_flow_team_members")
    .update(row)
    .eq("business_id", businessId)
    .eq("id", memberId)
    .select(MEMBER_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`updateTeamMember: ${error.message}`);
  return (data as TeamMemberRow | null) ?? null;
}

export async function deleteTeamMember(
  businessId: string,
  memberId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("ai_flow_team_members")
    .delete()
    .eq("business_id", businessId)
    .eq("id", memberId);
  if (error) throw new Error(`deleteTeamMember: ${error.message}`);
}

export async function listTimeOff(
  businessId: string,
  client?: SupabaseClient
): Promise<TimeOffRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("employee_time_off")
    .select(TIME_OFF_COLUMNS)
    .eq("business_id", businessId)
    .order("starts_on", { ascending: true });
  if (error) throw new Error(`listTimeOff: ${error.message}`);
  return (data ?? []) as TimeOffRow[];
}

export type TimeOffInput = {
  memberId: string;
  startsOn: string;
  endsOn: string;
  note?: string | null;
};

export async function addTimeOff(
  businessId: string,
  input: TimeOffInput,
  client?: SupabaseClient
): Promise<TimeOffRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("employee_time_off")
    .insert({
      business_id: businessId,
      member_id: input.memberId,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      note: input.note ?? null
    })
    .select(TIME_OFF_COLUMNS)
    .single();
  if (error) throw new Error(`addTimeOff: ${error.message}`);
  return data as TimeOffRow;
}

export async function deleteTimeOff(
  businessId: string,
  timeOffId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("employee_time_off")
    .delete()
    .eq("business_id", businessId)
    .eq("id", timeOffId);
  if (error) throw new Error(`deleteTimeOff: ${error.message}`);
}

// --- Routing stats -----------------------------------------------------------

export type EmployeeRoutingStats = {
  /** Lead offers sent to this phone (tried + currently offered + claims). */
  offered: number;
  /** Offers this phone claimed (reply "1"). */
  claimed: number;
  /** created_at of the newest run that offered to this phone. */
  lastOfferedAt: string | null;
  /** created_at of the newest run this phone claimed. */
  lastClaimedAt: string | null;
};

type RoutingRunLike = { created_at: string; context: unknown };

/**
 * Aggregate route_to_team outcomes per agent phone from run contexts.
 *
 * The engine persists routing state in `context.routing`: `tried[]` holds
 * every phone that was offered and rejected/timed out, `offered` the phone
 * currently holding the offer, and `claimed_by` the phone that replied "1".
 * A claim does NOT append to `tried`, so offers = tried ∪ offered ∪
 * claimed_by. Timestamps use the run's created_at — close enough for a
 * "last offered 2d ago" stat without storing per-offer events.
 */
export function aggregateRoutingStats(
  runs: RoutingRunLike[]
): Record<string, EmployeeRoutingStats> {
  const stats: Record<string, EmployeeRoutingStats> = {};
  const ensure = (phone: string): EmployeeRoutingStats =>
    (stats[phone] ??= { offered: 0, claimed: 0, lastOfferedAt: null, lastClaimedAt: null });
  const later = (a: string | null, b: string): string => (a !== null && a > b ? a : b);

  for (const run of runs) {
    const ctx = run.context;
    if (!ctx || typeof ctx !== "object") continue;
    const routing = (ctx as Record<string, unknown>).routing;
    if (!routing || typeof routing !== "object") continue;
    const r = routing as Record<string, unknown>;

    const offeredPhones = new Set<string>();
    if (Array.isArray(r.tried)) {
      for (const t of r.tried) {
        if (typeof t === "string" && t) offeredPhones.add(t);
      }
    }
    if (typeof r.offered === "string" && r.offered) offeredPhones.add(r.offered);
    const claimedBy = typeof r.claimed_by === "string" && r.claimed_by ? r.claimed_by : null;
    if (claimedBy) offeredPhones.add(claimedBy);

    for (const phone of offeredPhones) {
      const s = ensure(phone);
      s.offered += 1;
      s.lastOfferedAt = later(s.lastOfferedAt, run.created_at);
    }
    if (claimedBy) {
      const s = ensure(claimedBy);
      s.claimed += 1;
      s.lastClaimedAt = later(s.lastClaimedAt, run.created_at);
    }
  }
  return stats;
}

/** How many recent runs feed the stats — bounded so the page stays cheap. */
export const ROUTING_STATS_RUN_LIMIT = 500;

export async function listEmployeeRoutingStats(
  businessId: string,
  client?: SupabaseClient
): Promise<Record<string, EmployeeRoutingStats>> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("ai_flow_runs")
    .select("created_at, context")
    .eq("business_id", businessId)
    .not("context->routing", "is", null)
    .order("created_at", { ascending: false })
    .limit(ROUTING_STATS_RUN_LIMIT);
  if (error) throw new Error(`listEmployeeRoutingStats: ${error.message}`);
  return aggregateRoutingStats((data ?? []) as RoutingRunLike[]);
}
