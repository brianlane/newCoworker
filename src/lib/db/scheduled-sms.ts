/**
 * The dashboard's scheduled-SMS queue read.
 *
 * `scheduled_sms` is a residency-moved table, so for a tenant in
 * `data_residency_mode = 'vps'` the queued rows are served from that tenant's
 * box. Note what the purge actually removes: only TERMINAL rows (sent,
 * canceled, failed) older than the keep window, so central keeps every
 * PENDING row. The history pane is the one that would go incomplete
 * centrally; the pending pane would not. An unreachable box raises
 * ResidencyReadError, which the route turns into an error response, never
 * into an empty queue.
 *
 * Writes are NOT routed: central inserts replicate box-ward through the
 * `residency_journal_row` trigger and `src/lib/residency/replay.ts`.
 */

import type { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isVpsReadMode, readMovedRows } from "@/lib/residency/read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ScheduledSmsRow = {
  id: string;
  to_e164: string;
  body: string;
  send_at: string;
  status: string;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  /** "owner" or "sms_coworker": who queued it. See the schedule_text tool. */
  created_by: string;
};

/** Projection shared by the box and central paths so they cannot drift. */
const SCHEDULED_SMS_COLUMNS = [
  "id",
  "to_e164",
  "body",
  "send_at",
  "status",
  "error",
  "created_at",
  "sent_at",
  "created_by"
] as const;

/** Upcoming sends shown at once. */
export const SCHEDULED_SMS_PENDING_LIMIT = 50;
/** Dispatched/canceled rows kept as context under them. */
export const SCHEDULED_SMS_HISTORY_LIMIT = 10;

/**
 * Pending sends soonest-first, followed by the most recent non-pending rows.
 *
 * Pending ascends so a deep queue never hides what dispatches next (a
 * descending-only cap would drop the soonest rows); history descends so the
 * tail is the freshest.
 */
export async function listScheduledSmsForDashboard(
  businessId: string,
  db: SupabaseClient
): Promise<ScheduledSmsRow[]> {
  // One mode lookup for both queries.
  const vpsReadMode = await isVpsReadMode(businessId, db);
  if (vpsReadMode) {
    const [pending, history] = await Promise.all([
      readMovedRows<ScheduledSmsRow>(businessId, {
        table: "scheduled_sms",
        columns: [...SCHEDULED_SMS_COLUMNS],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          { column: "status", op: "eq", value: "pending" }
        ],
        order: [{ column: "send_at", ascending: true }],
        limit: SCHEDULED_SMS_PENDING_LIMIT
      }),
      readMovedRows<ScheduledSmsRow>(businessId, {
        table: "scheduled_sms",
        columns: [...SCHEDULED_SMS_COLUMNS],
        filters: [
          { column: "business_id", op: "eq", value: businessId },
          // The box compiles `neq` to `<>` with a bound parameter, the same
          // comparison PostgREST makes centrally.
          { column: "status", op: "neq", value: "pending" }
        ],
        order: [{ column: "send_at", ascending: false }],
        limit: SCHEDULED_SMS_HISTORY_LIMIT
      })
    ]);
    return [...pending, ...history];
  }
  const select = SCHEDULED_SMS_COLUMNS.join(", ");
  const [pendingRes, historyRes] = await Promise.all([
    db
      .from("scheduled_sms")
      .select(select)
      .eq("business_id", businessId)
      .eq("status", "pending")
      .order("send_at", { ascending: true })
      .limit(SCHEDULED_SMS_PENDING_LIMIT),
    db
      .from("scheduled_sms")
      .select(select)
      .eq("business_id", businessId)
      .neq("status", "pending")
      .order("send_at", { ascending: false })
      .limit(SCHEDULED_SMS_HISTORY_LIMIT)
  ]);
  if (pendingRes.error) throw new Error(`listScheduledSms: ${pendingRes.error.message}`);
  if (historyRes.error) throw new Error(`listScheduledSms: ${historyRes.error.message}`);
  return [
    ...((pendingRes.data ?? []) as unknown as ScheduledSmsRow[]),
    ...((historyRes.data ?? []) as unknown as ScheduledSmsRow[])
  ];
}
