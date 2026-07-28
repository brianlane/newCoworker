import { listBusinesses } from "@/lib/db/businesses";
import {
  listInboundDeadLetters,
  summarizeInboundDeadLetters
} from "@/lib/db/sms-dead-letters";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/LocalTime";

/** Two weeks is long enough to notice a pattern, short enough to stay actionable. */
const SINCE_DAYS = 14;
/** Rows shown. The COUNT is exact and independent of this (see the summary). */
const ROW_LIMIT = 20;

/**
 * Fleet-wide "inbound texts we could not process". Renders nothing when there
 * are none, so on a healthy fleet it takes no space and its presence alone is
 * the signal.
 *
 * Reads `sms_inbound_jobs` directly rather than a log table: the jobs ARE the
 * source of truth, so this cannot drift from what actually happened. Routine
 * unreplyable senders (short-code lead blasts) are completed normally by
 * `sms-inbound-worker`, so anything appearing here is worth a look.
 */
export async function InboundFailuresCard() {
  const [summary, rows] = await Promise.all([
    summarizeInboundDeadLetters({ sinceDays: SINCE_DAYS }),
    listInboundDeadLetters({ sinceDays: SINCE_DAYS, limit: ROW_LIMIT })
  ]);
  if (summary.total === 0 && rows.length === 0) return null;

  const businesses = await listBusinesses();
  const names = new Map(businesses.map((b) => [b.id, b.name]));
  const hidden = summary.total - rows.length;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
          Inbound texts that failed
        </h2>
        <Badge variant="error">{summary.total}</Badge>
      </div>
      <p className="mb-3 text-xs text-parchment/50">
        Texts the platform received but could not answer, last {SINCE_DAYS} days. Routine
        one-way senders (lead-service short codes) are not counted here, so these are real
        failures.
      </p>
      {summary.byBusiness.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-2">
          {summary.byBusiness.map((t) => (
            <li key={t.businessId}>
              <Badge variant="neutral">
                {names.get(t.businessId) ?? t.businessId}: {t.count}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <ul className="divide-y divide-parchment/10">
        {rows.map((r) => (
          <li key={r.id} className="space-y-1 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-parchment">
                {names.get(r.businessId) ?? r.businessId}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <LocalTime iso={r.createdAt} className="font-mono text-xs text-parchment/45" />
                <Badge variant="error">{r.error}</Badge>
              </div>
            </div>
            <p className="text-xs text-parchment/50">
              <span className="font-mono text-parchment/70">{r.from || "(no sender)"}</span>
              {r.attemptCount > 1 ? ` · ${r.attemptCount} attempts` : ""}
            </p>
            {r.preview && (
              <p className="break-words text-xs text-parchment/55">{r.preview}</p>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-3 text-xs text-parchment/40">
          Showing the {rows.length} most recent of {summary.total}.
        </p>
      )}
    </Card>
  );
}
