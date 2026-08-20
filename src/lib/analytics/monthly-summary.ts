/**
 * Monthly production summary, a calendar-month rollup of the business's
 * activity: calls, texts, voice minutes, missed calls (from the nightly
 * analytics snapshots, which survive retention pruning), plus new contacts
 * created (from `contacts`). Current month-to-date sits next to the
 * previous full month so the owner can see the month shaping up.
 *
 * Snapshots cover FINISHED days only (the nightly sweep runs after
 * midnight), so month-to-date lags today by up to a day, labeled in the
 * card rather than papered over.
 *
 * Residency: `analytics_daily_snapshots` is a central control-plane table,
 * but `contacts` is residency-moved, so the new-contact count for a
 * `vps`-mode tenant is counted on that tenant's box. Counting centrally
 * returned 0 for them, which reads as "nobody new called this month" next
 * to real call and text volume. An unreachable box raises
 * ResidencyReadError, which the analytics page turns into a hidden card.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { countMovedRows, isVpsReadMode } from "@/lib/residency/read";

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
  end: Date,
  vpsReadMode: boolean
): Promise<MonthActivity> {
  const startYmd = start.toISOString().slice(0, 10);
  const endYmd = end.toISOString().slice(0, 10);

  // Head count, never a row fetch: the card only needs "how many".
  const countNewContacts = async (): Promise<number> => {
    if (vpsReadMode) {
      return await countMovedRows(businessId, {
        table: "contacts",
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "type", op: "eq", value: "customer" },
          { column: "created_at", op: "gte", value: start.toISOString() },
          { column: "created_at", op: "lt", value: end.toISOString() }
        ]
      });
    }
    const contactsRes = await db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("type", "customer")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString());
    if (contactsRes.error) throw new Error(`monthActivity contacts: ${contactsRes.error.message}`);
    return contactsRes.count ?? 0;
  };

  const [snapshotRes, newContacts] = await Promise.all([
    db
      .from("analytics_daily_snapshots")
      .select("calls, sms_sent, voice_minutes, missed_calls")
      .eq("business_id", businessId)
      .gte("snapshot_date", startYmd)
      .lt("snapshot_date", endYmd),
    countNewContacts()
  ]);
  if (snapshotRes.error) throw new Error(`monthActivity snapshots: ${snapshotRes.error.message}`);

  type Row = { calls: number; sms_sent: number; voice_minutes: number; missed_calls: number };
  const rows = ((snapshotRes.data as Row[] | null) ?? []);
  const sum = (pick: (r: Row) => number) => rows.reduce((s, r) => s + pick(r), 0);
  return {
    month: monthKey(start),
    calls: sum((r) => r.calls),
    texts: sum((r) => r.sms_sent),
    voiceMinutes: sum((r) => r.voice_minutes),
    missedCalls: sum((r) => r.missed_calls),
    newContacts,
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
  // Resolved once for both months rather than per query.
  const vpsReadMode = await isVpsReadMode(businessId, db);
  const [current, previous] = await Promise.all([
    monthActivity(db, businessId, currentStart, nextStart, vpsReadMode),
    monthActivity(db, businessId, previousStart, currentStart, vpsReadMode)
  ]);
  return { current, previous };
}
