/**
 * CSV shaping for the analytics export (BizBlasts ExportService analog).
 * Pure — the API route handles auth/tier gating and the HTTP envelope.
 */

import { serializeCsv } from "@/lib/csv/csv";
import type { DailyUsagePoint } from "@/lib/analytics/dashboard-analytics";
import type { FlowFunnelRow } from "@/lib/analytics/flow-funnels";

/**
 * Trailing note row appended when a scan cap truncated the source data, so
 * a downloaded file carries the same honesty as the dashboard footnotes.
 */
const CLIPPED_NOTE =
  "note: high volume this window - counts cover the most recent activity only";

/** Daily volume series → spreadsheet-ready CSV (oldest first, totals last). */
export function dailySeriesCsv(days: DailyUsagePoint[], clipped = false): string {
  const totals = days.reduce(
    (acc, d) => ({
      calls: acc.calls + d.calls,
      sms: acc.sms + d.sms,
      voiceMinutes: acc.voiceMinutes + d.voiceMinutes
    }),
    { calls: 0, sms: 0, voiceMinutes: 0 }
  );
  return serializeCsv([
    ["date", "calls", "texts", "voice_minutes"],
    ...days.map((d) => [d.date, d.calls, d.sms, d.voiceMinutes]),
    ["total", totals.calls, totals.sms, totals.voiceMinutes],
    ...(clipped ? [[CLIPPED_NOTE]] : [])
  ]);
}

/** Per-flow funnel rows → CSV. */
export function flowFunnelsCsv(rows: FlowFunnelRow[], clipped = false): string {
  return serializeCsv([
    ["flow", "enabled", "runs", "texts_sent", "links_clicked", "link_clicks", "goals_reached"],
    ...rows.map((r) => [
      r.flowName,
      r.enabled ? "yes" : "no",
      r.runs,
      r.textsSent,
      r.linksClicked,
      r.linkClicks,
      r.goalsReached
    ]),
    ...(clipped ? [[CLIPPED_NOTE]] : [])
  ]);
}
