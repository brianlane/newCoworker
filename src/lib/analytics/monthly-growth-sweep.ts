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
 * - tenants who declined THIS email (`email_monthly_recap = false`) and
 *   tenants who unsubscribed from everything (`unsubscribed_at`). The recap
 *   has its own flag because the footer link has to be proportionate: sending
 *   someone to the global unsubscribe to stop a monthly summary would have
 *   cost them urgent lead alerts on every channel.
 * - tenants who have stopped (`dormant`) and tenants whose month is too thin
 *   to be worth an email (`thin_data`). See `classifyRecap`: a summary of a
 *   month someone has since abandoned is the wrong message, and a table of
 *   near-zeros tells the reader less than silence does.
 * - tenants with no complete month yet: nothing to say, and the template
 *   returns null for them anyway.
 * - tenants whose newest MEASURED month is older than the one being reported
 *   (onboarded last week, or a snapshot sweep behind): claiming the month and
 *   mailing an older one would also burn the stamp, so the month is left for
 *   a later pass.
 * - tenants with no live subscription. This is what keeps the recap off the
 *   demo and app-review sandboxes, and it is a data signal rather than a name
 *   heuristic: every sandbox has zero live rows and every real customer has
 *   one. Dormancy alone would not do it, because a reviewer exercising a
 *   sandbox during an app review makes it look active for that month, and the
 *   recap would go to a reviewer address.
 * - wiped tenants and tenants with no owner email: no recipient.
 *
 * Every skip is COUNTED and the reason is returned, so "why did nobody get
 * one?" is answerable from the sweep's own response rather than by re-running
 * it with logging.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listBusinesses, type BusinessRow } from "@/lib/db/businesses";
import { listBusinessIdsWithLiveSubscription } from "@/lib/db/subscriptions";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildMonthlyGrowthEmail } from "@/lib/email/templates/monthly-growth";
import { classifyRecap, loadGrowthReport } from "@/lib/analytics/growth-report";
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
  | "no_subscription"
  | "unsubscribed"
  | "recap_declined"
  | "dormant"
  | "thin_data"
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
  loadLiveSubscriptions?: typeof listBusinessIdsWithLiveSubscription;
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
  consent: { unsubscribed: boolean; recapEnabled: boolean; paying: boolean }
): MonthlyGrowthSkipReason | null {
  // No stamp check here: the candidate filter already dropped rows reported
  // this month, and a row stamped between that read and now is caught by the
  // claim below, which is atomic and therefore the authoritative guard. A
  // second check here would be a branch nothing could reach.
  if (business.status === "wiped") return "wiped";
  if (!business.owner_email?.trim()) return "no_owner_email";
  if (!consent.paying) return "no_subscription";
  if (consent.unsubscribed) return "unsubscribed";
  if (!consent.recapEnabled) return "recap_declined";
  return null;
}

export async function sweepMonthlyGrowthEmails(
  deps: MonthlyGrowthSweepDeps = {}
): Promise<MonthlyGrowthSweepResult> {
  /* c8 ignore start -- production defaults; unit tests inject every dependency */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const loadBusinesses = deps.loadBusinesses ?? listBusinesses;
  const loadLiveSubscriptions = deps.loadLiveSubscriptions ?? listBusinessIdsWithLiveSubscription;
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

  // Drop rows already reported for this month BEFORE the cap, not after.
  //
  // `listBusinesses` is newest-first, so capping the raw list means that once
  // the fleet passes GROWTH_EMAIL_BATCH_LIMIT every pass walks the same newest
  // N and the older tenants never get a recap at all: the stamp made them
  // no-ops that still consumed their slot. Filtering first makes each pass
  // take the next N tenants that still need one, so a large fleet is covered
  // over several days within the month rather than never.
  //
  // Rows that are skipped for a reason we do NOT stamp (unsubscribed, recap
  // declined, wiped, no owner email) do still occupy a slot on every pass.
  // That is deliberate and bounded: those checks have to re-run daily because
  // an owner can re-enable the recap mid-month, and stamping them would make
  // that impossible.
  const all = (await loadBusinesses(db)) as BusinessWithStamp[];
  const businesses = all
    .filter((b) => b.monthly_growth_email_sent_for !== month)
    .slice(0, GROWTH_EMAIL_BATCH_LIMIT);
  result.scanned = businesses.length;

  if (!apiKey) {
    logger.warn("monthly-growth-sweep: RESEND_API_KEY missing; skipping sends", {
      scanned: businesses.length
    });
    result.skipped = businesses.length;
    return result;
  }

  // One read for the whole batch rather than one per tenant, and only once we
  // know a send is possible at all. Both kinds of live row count: an
  // admin-created enterprise account with no Stripe id is still a customer
  // who should hear how their month went.
  const live = await loadLiveSubscriptions(
    businesses.map((b) => b.id),
    db
  );
  const paying = new Set([...live.stripeBacked, ...live.stripeless]);

  for (const business of businesses) {
    try {
      // Preferences failing open would email someone who opted out, so a read
      // failure is treated as opted out here (the opposite posture to urgent
      // alerts, which fail toward delivering: a missed recap costs nothing, a
      // missed lead alert costs a lead).
      const prefs = await loadPreferences(business.id, db).catch(() => null);
      const consent = {
        paying: paying.has(business.id),
        unsubscribed: prefs === null || prefs.unsubscribed_at !== null,
        // `?? true` for rows written before 20260829061823, matching the
        // column default rather than silently muting every existing tenant.
        recapEnabled: prefs !== null && (prefs.email_monthly_recap ?? true)
      };

      const preflight = preflightSkip(business, consent);
      if (preflight) {
        skip(preflight);
        continue;
      }

      const report = await loadReport(business.id, { client: db, now });
      const verdict = classifyRecap(report);
      if (verdict === "no_month") {
        skip("no_complete_month");
        continue;
      }
      if (verdict === "dormant") {
        skip("dormant");
        continue;
      }
      if (verdict === "thin") {
        skip("thin_data");
        continue;
      }
      // The report DROPS months with no snapshot coverage, so its newest month
      // is not always the month this pass is claiming: a tenant onboarded last
      // week, or a snapshot sweep that has not caught up, leaves the newest
      // measured month older than `month`. Sending then would stamp August and
      // mail a July recap, and the stamp would stop August ever going out.
      if (report.latest!.month !== month) {
        skip("no_data_for_month");
        continue;
      }

      const toEmail = business.owner_email.trim();
      const locale = await resolveLocale(toEmail);
      // Scoped: this link stops the recap and nothing else. It goes to BOTH
      // the template (the footer link in the HTML) and the sender, which is
      // what attaches the RFC 8058 List-Unsubscribe / List-Unsubscribe-Post
      // headers and appends a plain-text footer. Without the second, Gmail
      // and Apple Mail never render their native Unsubscribe control, which
      // is the one this scope was built for, a text-only client has no way
      // out at all, and a recurring email missing those headers is exactly
      // what bulk-sender rules penalize.
      const unsubscribeUrl =
        `${siteUrl}/api/notifications/unsubscribe` +
        `?bid=${encodeURIComponent(business.id)}&scope=monthly_recap`;
      const email = buildMonthlyGrowthEmail({
        report,
        businessName: business.name,
        ownerName: business.owner_name ?? null,
        recipientEmail: toEmail,
        siteUrl,
        unsubscribeUrl,
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

      await send(apiKey, toEmail, email.subject, {
        text: email.text,
        html: email.html,
        unsubscribeUrl
      });
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
