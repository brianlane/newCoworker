/**
 * Channel liveness: the daily alarm.
 *
 * The read-only judgement lives next door in `./channel-liveness-read.ts`,
 * shared verbatim with `debug/channel-liveness-report.ts`. The only thing
 * this file adds is the writing, so there is exactly one place where "is
 * this tenant still reachable" is decided and the operator's report can
 * never disagree with the alarm the operator is investigating.
 *
 * ADMIN-ONLY, BY DECISION. Everything here writes to `system_logs`, which
 * reaches the admin System Errors card. Tenant dashboards read that table
 * only through a `source: "aiflow"` filter, so none of this becomes
 * customer-visible. Delivery failures are ours to watch, not the customer's
 * to worry about.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordSystemLog } from "@/lib/db/system-logs";
import { livenessFinding } from "./channel-liveness";
import { reportChannelLiveness } from "./channel-liveness-read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type LivenessSweepResult = {
  checked: number;
  dark: number;
  degraded: number;
  healthy: number;
  /** Tenants not judged, and why. */
  skipped: { businessId: string; reason: string }[];
  errors: string[];
};


export async function sweepChannelLiveness(
  opts: { now?: number; client?: SupabaseClient } = {}
): Promise<LivenessSweepResult> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const rows = await reportChannelLiveness({ ...opts, client: db });
  const result: LivenessSweepResult = {
    checked: 0,
    dark: 0,
    degraded: 0,
    healthy: 0,
    skipped: [],
    errors: []
  };

  for (const row of rows) {
    if (row.outcome === "skipped") {
      result.skipped.push({ businessId: row.business.id, reason: row.reason });
      continue;
    }
    if (row.outcome === "failed") {
      result.errors.push(`${row.business.id}: ${row.error}`);
      continue;
    }
    result.checked += 1;
    const finding = livenessFinding(row.business.name, row.judgement);
    if (!finding) {
      result.healthy += 1;
      continue;
    }
    if (row.judgement.state === "dark") result.dark += 1;
    else result.degraded += 1;
    await recordSystemLog(
      {
        businessId: row.business.id,
        level: finding.level,
        source: "notifications",
        event: finding.event,
        message: finding.message,
        payload: finding.payload
      },
      db
    );
  }
  return result;
}
