/**
 * Monthly production summary — a calendar-month rollup of the business's
 * activity: calls, texts, voice minutes, missed calls (from the nightly
 * analytics snapshots, which survive retention pruning), plus new contacts
 * created (from `contacts`). Current month-to-date sits next to the
 * previous full month so the owner can see the month shaping up.
 *
 * Snapshots cover FINISHED days only (the nightly sweep runs after
 * midnight), so month-to-date lags today by up to a day — labeled in the
 * card rather than papered over.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type MonthActivity = {
  /** "YYYY-MM". */
  month: string;
  calls: number;
  texts: number;
  voiceMinutes: number;
  missedCalls: number;
  newContacts: number;
  /** Days of the month with a snapshot row (coverage indicator). */
  coveredDays: number;
};

export type MonthlySummary = {
  current: MonthActivity;
  previous: MonthActivity;
};

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** First instant of the month `offset` months from `now`'s month (UTC). */
export function monthStart(now: Date, offset = 0): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

async function monthActivity(
  db: SupabaseClient,
  businessId: string,
  start: Date,
  end: Date
): Promise<MonthActivity> {
  const startYmd = start.toISOString().slice(0, 10);
  const endYmd = end.toISOString().slice(0, 10);
  const [snapshotRes, contactsRes] = await Promise.all([
    db
      .from("analytics_daily_snapshots")
      .select("calls, sms_sent, voice_minutes, missed_calls")
      .eq("business_id", businessId)
      .gte("snapshot_date", startYmd)
      .lt("snapshot_date", endYmd),
    db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("type", "customer")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString())
  ]);
  if (snapshotRes.error) throw new Error(`monthActivity snapshots: ${snapshotRes.error.message}`);
  if (contactsRes.error) throw new Error(`monthActivity contacts: ${contactsRes.error.message}`);

  type Row = { calls: number; sms_sent: number; voice_minutes: number; missed_calls: number };
  const rows = ((snapshotRes.data as Row[] | null) ?? []);
  const sum = (pick: (r: Row) => number) => rows.reduce((s, r) => s + pick(r), 0);
  return {
    month: monthKey(start),
    calls: sum((r) => r.calls),
    texts: sum((r) => r.sms_sent),
    voiceMinutes: sum((r) => r.voice_minutes),
    missedCalls: sum((r) => r.missed_calls),
    newContacts: contactsRes.count ?? 0,
    coveredDays: rows.length
  };
}

export async function getMonthlySummary(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<MonthlySummary> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const currentStart = monthStart(now);
  const nextStart = monthStart(now, 1);
  const previousStart = monthStart(now, -1);
  const [current, previous] = await Promise.all([
    monthActivity(db, businessId, currentStart, nextStart),
    monthActivity(db, businessId, previousStart, currentStart)
  ]);
  return { current, previous };
}
