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
import {
  getNotificationPreferences,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";
import { livenessFinding } from "./channel-liveness";
import type { AudienceJudgement } from "./channel-liveness";
import { reportChannelLiveness } from "./channel-liveness-read";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type LivenessSweepResult = {
  checked: number;
  dark: number;
  degraded: number;
  healthy: number;
  /** Tenants switched to push-instead-of-text this run, on measured evidence. */
  pushReplacedSms: number;
  /** Tenants not judged, and why. */
  skipped: { businessId: string; reason: string }[];
  errors: string[];
};


/**
 * Turn on "push instead of text" for a tenant that has EARNED it.
 *
 * Two measured facts, never a guess:
 *
 *   push is `live`  a human tapped a notification recently. This is the one
 *                   channel that produces a real read receipt, which is what
 *                   makes substituting a paid channel defensible at all.
 *   sms is `silent` at least ten alerts landed in the window and nobody
 *                   answered any of them. We are paying per message for a
 *                   channel that is not being read.
 *
 * `unused` on the SMS side is deliberately NOT enough. That verdict means too
 * few alerts to judge, which is absence of evidence rather than evidence of
 * absence, and suppressing a channel on it would be the exact mistake this
 * whole check exists to prevent.
 *
 * Only ever acts on a NULL preference. An explicit false is an owner's
 * decision, and a sweep that overturned it would be worse than one that never
 * ran. Writes a system log either way it fires, so a substitution nobody
 * asked for is visible rather than silent.
 */
async function autoEnablePushInsteadOfSms(
  business: { id: string; name: string },
  judgement: AudienceJudgement,
  db: SupabaseClient
): Promise<boolean> {
  const push = judgement.channels.find((c) => c.channel === "push");
  const sms = judgement.channels.find((c) => c.channel === "sms");
  if (push?.verdict !== "live" || sms?.verdict !== "silent") return false;

  const prefs = await getNotificationPreferences(business.id, db);
  // Undecided only. null and undefined both mean nobody has chosen; false is
  // a choice.
  if (prefs?.push_replaces_sms !== null && prefs?.push_replaces_sms !== undefined) return false;

  await updateNotificationPreferences(business.id, { push_replaces_sms: true }, db);
  await recordSystemLog(
    {
      businessId: business.id,
      level: "info",
      source: "notifications",
      event: "push_replaces_sms_enabled",
      message:
        `Urgent alerts for ${business.name} now go by push instead of text. ` +
        `Push is being read (${push.detail}) and the text is not (${sms.detail}), ` +
        "so the SMS was being paid for and ignored. Turn it back on under " +
        "notification settings at any time; that choice is never overridden.",
      payload: { push: push.detail, sms: sms.detail }
    },
    db
  );
  return true;
}

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
    pushReplacedSms: 0,
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
    // Before judging the audience: a tenant whose push is read and whose text
    // is not should stop paying for the text.
    if (await autoEnablePushInsteadOfSms(row.business, row.judgement, db)) {
      result.pushReplacedSms += 1;
    }
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
