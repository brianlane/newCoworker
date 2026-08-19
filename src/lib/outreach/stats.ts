/**
 * Prospecting, the funnel the owner surface reports.
 *
 * The honedtech lesson this encodes: drafted and sent are DIFFERENT events,
 * and conflating them makes the dashboard claim outreach that never happened.
 * A status email once read "Contacted: 15" against an empty sent folder. So
 * every number here is named for the event it counts, the reply rate is a
 * share of what was SENT, and drafts still waiting are reported as waiting
 * rather than folded into a total.
 *
 * Pure aggregation over the rows db.listProspectOutcomes returns, so the
 * per-vertical breakdown is testable without a database.
 */

import type { OutreachProspectStatus } from "./db";

export type OutreachFunnel = {
  discovered: number;
  drafted: number;
  /** Drafts waiting on the owner (manual mode), not yet outreach. */
  pending: number;
  /**
   * Prospects that have not gone out and could still be called off: exactly
   * the statuses `skipProspectsInVertical` retires, so a row's Skip button and
   * the number beside it cannot disagree about what pressing it would do.
   * `queued` is excluded here for the same reason it is excluded there: it is
   * already in flight.
   */
  open: number;
  sent: number;
  replied: number;
  booked: number;
  unsubscribed: number;
  skipped: number;
  failed: number;
  /** Replies as a share of sends, 0 when nothing has been sent. */
  replyRate: number;
};

export type VerticalFunnel = OutreachFunnel & { vertical: string };

/**
 * Statuses that prove a send happened. `sent` is the send itself; the later
 * states are what a sent prospect became, so they still count as sent.
 * Without this a reply would silently decrement the send count.
 */
const SENT_STATUSES: OutreachProspectStatus[] = [
  "sent",
  "replied",
  "booked",
  "unsubscribed"
];

/** Statuses that prove a draft exists, whatever became of it afterwards. */
const DRAFTED_STATUSES: OutreachProspectStatus[] = [
  "drafted",
  "queued",
  ...SENT_STATUSES,
  "skipped"
];

/**
 * The bucket rows with no recorded trade group under.
 *
 * Exported because it is a LABEL, not a stored value: no `outreach_prospects`
 * row has this in its `vertical` column. Anything acting on the bucket (the
 * per-trade skip) has to translate it back into "null or blank", and the two
 * ends of that translation must not drift apart, or the button silently
 * matches nothing.
 */
export const UNKNOWN_VERTICAL = "(unknown)";

function emptyFunnel(): OutreachFunnel {
  return {
    discovered: 0,
    drafted: 0,
    pending: 0,
    open: 0,
    sent: 0,
    replied: 0,
    booked: 0,
    unsubscribed: 0,
    skipped: 0,
    failed: 0,
    replyRate: 0
  };
}

function tally(funnel: OutreachFunnel, status: OutreachProspectStatus): void {
  funnel.discovered += 1;
  if (DRAFTED_STATUSES.includes(status)) funnel.drafted += 1;
  if (SENT_STATUSES.includes(status)) funnel.sent += 1;
  // "Pending" is the owner's queue: drafted, not yet sent, not yet passed on.
  if (status === "drafted" || status === "queued") funnel.pending += 1;
  // "Open" is what a per-trade Skip would still catch. Kept in lockstep with
  // CANCELLABLE_STATUSES in db.ts: a row's button offering to skip a count it
  // cannot actually skip is worse than no count at all.
  if (status === "discovered" || status === "drafted") funnel.open += 1;
  if (status === "replied" || status === "booked") funnel.replied += 1;
  if (status === "booked") funnel.booked += 1;
  if (status === "unsubscribed") funnel.unsubscribed += 1;
  if (status === "skipped") funnel.skipped += 1;
  if (status === "failed") funnel.failed += 1;
}

function finalize(funnel: OutreachFunnel): OutreachFunnel {
  funnel.replyRate = funnel.sent === 0 ? 0 : funnel.replied / funnel.sent;
  return funnel;
}

/**
 * The whole-business funnel plus a per-vertical breakdown. The breakdown, not
 * the mix of any one pass, is the evidence for whether a trade deserves more
 * attention: discovery rotation alone can make one vertical dominate a day.
 * Rows discovered before a vertical was recorded group under "(unknown)".
 */
export function summarizeFunnel(
  rows: Array<{ status: OutreachProspectStatus; vertical: string }>
): { total: OutreachFunnel; byVertical: VerticalFunnel[] } {
  const total = emptyFunnel();
  const byVertical = new Map<string, OutreachFunnel>();
  for (const row of rows) {
    tally(total, row.status);
    const key = row.vertical.trim() || UNKNOWN_VERTICAL;
    const bucket = byVertical.get(key) ?? emptyFunnel();
    tally(bucket, row.status);
    byVertical.set(key, bucket);
  }
  return {
    total: finalize(total),
    byVertical: [...byVertical.entries()]
      .map(([vertical, funnel]) => ({ vertical, ...finalize(funnel) }))
      // A trade with nothing sent and nothing left to send answers the question
      // this table asks ("which trades actually reply") with silence, and it
      // cannot be acted on either. It is dropped rather than left as a row
      // whose numbers never move again. Anything with a send stays, however
      // long ago: that is the reply evidence the table exists for.
      .filter((v) => v.sent > 0 || v.open > 0)
      .sort((a, b) => b.sent - a.sent || b.discovered - a.discovered)
  };
}
