/**
 * Daily sweep that sends each owner one recap a month, about the month that
 * just ended.
 *
 * WHY IT WAITS A FEW DAYS. The figures come from `analytics_daily_snapshots`,
 * written by the nightly snapshot sweep, so the last day of a month is not on
 * disk until the following day. Sending on the 1st would report a month
 * missing its busiest-looking final day. {@link GROWTH_EMAIL_SEND_DAY} is the
 * settle margin.
 *
 * IDEMPOTENCE. `businesses.monthly_growth_email_sent_for` holds the month
 * ("YYYY-MM") already reported, and is claimed BEFORE the send with a
 * conditional update, so two overlapping ticks cannot both win. A crash
 * mid-send therefore drops that month's email for that tenant, which is the
 * right trade: a missed recap is a non-event, a duplicate is embarrassing.
 *
 * WHO IS SKIPPED, and why each one:
 *
 * - unsubscribed tenants: `notification_preferences.unsubscribed_at`. This is
 *   a recap, not a transactional notice, so a global unsubscribe governs it.
 * - tenants with nothing to report: a month with no leads, no texts and no
 *   calls produces a table of zeros, which is worse than silence.
 * - tenants with no complete month yet: nothing to say, and the template
 *   returns null for them anyway.
 * - tenants whose newest MEASURED month is older than the one being reported
 *   (onboarded last week, or a snapshot sweep behind): claiming the month and
 *   mailing an older one would also burn the stamp, so the month is left for
 *   a later pass.
 * - wiped tenants and tenants with no owner email: no recipient.
 *
 * Every skip is COUNTED and the reason is returned, so "why did nobody get
 * one?" is answerable from the sweep's own response rather than by re-running
 * it with logging.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listBusinesses, type BusinessRow } from "@/lib/db/businesses";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildMonthlyGrowthEmail } from "@/lib/email/templates/monthly-growth";
import { hasReportableActivity, loadGrowthReport } from "@/lib/analytics/growth-report";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Day of the month from which the previous month's recap may go out.
 *
 * Third, not first: the nightly snapshot sweep writes a day after it ends, so
 * the month's final day lands on the 1st, and one spare day absorbs a skipped
 * or retried nightly run.
 */
const GROWTH_EMAIL_SEND_DAY = 3;

/** Per-pass ceiling so one long run cannot starve the rest of the fleet. */
const GROWTH_EMAIL_BATCH_LIMIT = 200;

type MonthlyGrowthSkipReason =
  | "too_early_in_month"
  | "already_sent"
  | "no_owner_email"
  | "wiped"
  | "unsubscribed"
  | "no_activity"
  | "no_complete_month"
  | "no_data_for_month";

export type MonthlyGrowthSweepResult = {
  /** The month every send in this pass is about ("YYYY-MM"). */
  month: string;
  scanned: number;
  sent: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errors: Array<{ businessId: string; message: string }>;
};

export type MonthlyGrowthSweepDeps = {
  client?: SupabaseClient;
  now?: Date;
  loadBusinesses?: typeof listBusinesses;
  loadReport?: typeof loadGrowthReport;
  loadPreferences?: typeof getNotificationPreferences;
  sendEmail?: typeof sendOwnerEmail;
  resolveLocale?: typeof resolveOwnerUiLocaleForEmail;
  siteUrl?: string;
  resendApiKey?: string | null;
};

/** "YYYY-MM" of the month before `now`'s. */
function targetMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

/** Whether the previous month has settled enough to report on. */
function isSendWindowOpen(now: Date): boolean {
  return now.getUTCDate() >= GROWTH_EMAIL_SEND_DAY;
}

/**
 * Claim the month for one business. Returns true only if this caller won.
 *
 * The `neq` is what makes it a claim rather than a write: a row already
 * stamped with this month matches nothing, so the update touches zero rows
 * and `data` comes back null. A no-match PostgREST write reports no error, so
 * the `.select()` is load-bearing, not decorative.
 */
async function claimGrowthEmail(
  db: SupabaseClient,
  businessId: string,
  month: string
): Promise<boolean> {
  const { data, error } = await db
    .from("businesses")
    .update({ monthly_growth_email_sent_for: month })
    .eq("id", businessId)
    .or(`monthly_growth_email_sent_for.is.null,monthly_growth_email_sent_for.neq.${month}`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`claimGrowthEmail: ${error.message}`);
  return data !== null;
}

type BusinessWithStamp = BusinessRow & { monthly_growth_email_sent_for?: string | null };

/**
 * Reasons a business is skipped that can be decided WITHOUT reading its
 * activity, so the expensive report load only runs for real candidates.
 */
function preflightSkip(
  business: BusinessWithStamp,
  month: string,
  unsubscribed: boolean
): MonthlyGrowthSkipReason | null {
  if (business.monthly_growth_email_sent_for === month) return "already_sent";
  if (business.status === "wiped") return "wiped";
  if (!business.owner_email?.trim()) return "no_owner_email";
  if (unsubscribed) return "unsubscribed";
  return null;
}

export async function sweepMonthlyGrowthEmails(
  deps: MonthlyGrowthSweepDeps = {}
): Promise<MonthlyGrowthSweepResult> {
  /* c8 ignore start -- production defaults; unit tests inject every dependency */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const loadBusinesses = deps.loadBusinesses ?? listBusinesses;
  const loadReport = deps.loadReport ?? loadGrowthReport;
  const loadPreferences = deps.loadPreferences ?? getNotificationPreferences;
  const send = deps.sendEmail ?? sendOwnerEmail;
  const resolveLocale = deps.resolveLocale ?? resolveOwnerUiLocaleForEmail;
  /* c8 ignore stop */
  const now = deps.now ?? new Date();
  const siteUrl = (
    deps.siteUrl ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const apiKey =
    deps.resendApiKey !== undefined ? deps.resendApiKey : (process.env.RESEND_API_KEY ?? null);

  const month = targetMonth(now);
  const result: MonthlyGrowthSweepResult = {
    month,
    scanned: 0,
    sent: 0,
    skipped: 0,
    skipReasons: {},
    errors: []
  };

  const skip = (reason: MonthlyGrowthSkipReason): void => {
    result.skipped += 1;
    result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1;
  };

  if (!isSendWindowOpen(now)) {
    logger.info("monthly-growth-sweep: before the send day, nothing to do", {
      month,
      sendDay: GROWTH_EMAIL_SEND_DAY
    });
    return result;
  }

  const businesses = (await loadBusinesses(db)).slice(
    0,
    GROWTH_EMAIL_BATCH_LIMIT
  ) as BusinessWithStamp[];
  result.scanned = businesses.length;

  if (!apiKey) {
    logger.warn("monthly-growth-sweep: RESEND_API_KEY missing; skipping sends", {
      scanned: businesses.length
    });
    result.skipped = businesses.length;
    return result;
  }

  for (const business of businesses) {
    try {
      // Preferences failing open would email someone who unsubscribed, so a
      // read failure is treated as unsubscribed here (the opposite posture to
      // urgent alerts, which fail toward delivering).
      const prefs = await loadPreferences(business.id, db).catch(() => null);
      const unsubscribed = prefs === null || prefs.unsubscribed_at !== null;

      const preflight = preflightSkip(business, month, unsubscribed);
      if (preflight) {
        skip(preflight);
        continue;
      }

      const report = await loadReport(business.id, { client: db, now });
      if (!report.latest) {
        skip("no_complete_month");
        continue;
      }
      // The report DROPS months with no snapshot coverage, so its newest month
      // is not always the month this pass is claiming: a tenant onboarded last
      // week, or a snapshot sweep that has not caught up, leaves the newest
      // measured month older than `month`. Sending then would stamp August and
      // mail a July recap, and the stamp would stop August ever going out.
      if (report.latest.month !== month) {
        skip("no_data_for_month");
        continue;
      }
      if (!hasReportableActivity(report)) {
        skip("no_activity");
        continue;
      }

      const toEmail = business.owner_email.trim();
      const locale = await resolveLocale(toEmail);
      const email = buildMonthlyGrowthEmail({
        report,
        businessName: business.name,
        ownerName: business.owner_name ?? null,
        recipientEmail: toEmail,
        siteUrl,
        unsubscribeUrl: `${siteUrl}/api/notifications/unsubscribe?bid=${encodeURIComponent(
          business.id
        )}`,
        locale
      });
      /* c8 ignore next 4 -- unreachable: report.latest was checked above, which
         is the only condition under which the builder returns null. Kept as a
         type narrowing, not as a branch anyone can exercise. */
      if (!email) {
        skip("no_complete_month");
        continue;
      }

      // Claim before send so a crash cannot double-email.
      if (!(await claimGrowthEmail(db, business.id, month))) {
        skip("already_sent");
        continue;
      }

      await send(apiKey, toEmail, email.subject, { text: email.text, html: email.html });
      result.sent += 1;
    } catch (err) {
      result.errors.push({
        businessId: business.id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}
