/**
 * Daily sweep: one polite email to month-to-month owners still on their
 * first-month intro, 5 business days before the first renewal.
 *
 * Idempotence: `monthly_intro_nudge_sent_at` is stamped BEFORE the send, so
 * an overlapping tick or a crash mid-send can never double-email. Prefer a
 * missed nudge over a duplicate.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import { subtractBusinessDays } from "@/lib/datetime/business-days";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildMonthlyIntroNudgeEmail } from "@/lib/email/templates/monthly-intro-nudge";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How far ahead of period_end the scan looks (covers 5 biz days + weekend slack). */
export const MONTHLY_INTRO_NUDGE_SCAN_DAYS = 10;

/** Lead time before period end, in business days. */
export const MONTHLY_INTRO_NUDGE_BUSINESS_DAYS = 5;

/** Per-pass ceiling so one busy day cannot starve the rest of the fleet. */
export const MONTHLY_INTRO_NUDGE_BATCH_LIMIT = 200;

/**
 * Scan only subscriptions created within this many days. Renewed monthlies are
 * older; keeping them out of the SELECT stops them from filling the batch
 * limit ahead of true first-month rows.
 */
export const MONTHLY_INTRO_NUDGE_MAX_AGE_DAYS = 45;

/**
 * First-cycle slack between subscription.created_at and Stripe period_start.
 * Pending rows are inserted at /api/checkout; period_start is written only when
 * the Stripe subscription activates, which can lag by days (async/manual
 * checkout). Renewed monthlies have period_start a full cycle after created_at,
 * so a ~14 day window still excludes them.
 */
const FIRST_CYCLE_SLACK_MS = 14 * 24 * 60 * 60 * 1000;

export type MonthlyIntroNudgeCandidate = {
  id: string;
  business_id: string;
  tier: PlanTier;
  status: string;
  billing_period: string | null;
  cancel_at_period_end: boolean;
  billing_paused: boolean;
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
  created_at: string;
  monthly_intro_nudge_sent_at: string | null;
};

const COLUMNS =
  "id,business_id,tier,status,billing_period,cancel_at_period_end,billing_paused," +
  "stripe_current_period_start,stripe_current_period_end,created_at,monthly_intro_nudge_sent_at";

export type MonthlyIntroNudgeSweepDeps = {
  client?: SupabaseClient;
  sendEmail?: typeof sendOwnerEmail;
  resolveLocale?: typeof resolveOwnerUiLocaleForEmail;
  getBusinessRow?: typeof getBusiness;
  now?: () => Date;
  siteUrl?: string;
  resendApiKey?: string | null;
};

export type MonthlyIntroNudgeSweepResult = {
  scanned: number;
  sent: number;
  skipped: number;
  errors: Array<{ subscriptionId: string; message: string }>;
};

export function isFirstBillingCycle(
  createdAt: string,
  periodStart: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!periodStart) return false;
  const createdMs = Date.parse(createdAt);
  const startMs = Date.parse(periodStart);
  if (!Number.isFinite(createdMs) || !Number.isFinite(startMs)) return false;
  // Still in the period that started near signup (allowing pending→active delay).
  if (createdMs < startMs - FIRST_CYCLE_SLACK_MS) return false;
  // Period start must not be far in the future; a renewed sub has
  // period_start well after created_at.
  return startMs <= nowMs + FIRST_CYCLE_SLACK_MS;
}

/**
 * Rows that will never become eligible (renewed cycle, wrong tier). Stamp them
 * so they leave the partial index and stop crowding the scan batch.
 * Temporary states (paused, cancel-at-period-end, not-yet-in-window) stay
 * unstamped so a later pass can still send.
 */
export function shouldRetireNudgeCandidate(row: MonthlyIntroNudgeCandidate): boolean {
  // Tier is the only PERMANENT ineligibility: an enterprise row has no intro
  // price to warn about and never will.
  //
  // Deliberately NOT retiring on isFirstBillingCycle. Retiring stamps
  // monthly_intro_nudge_sent_at, which is irreversible: the row leaves the
  // partial index and that tenant can never be nudged, even though nothing
  // was sent. And "looks renewed" is not permanent: moving a tenant's billing
  // date (the admin comp lever) re-anchors stripe_current_period_start to the
  // change, so a first-cycle tenant who gets comped read as renewed and was
  // silently stamped, then hit their real renewal with no warning that the
  // intro price had ended.
  //
  // Not SENDING to those rows is already handled independently by
  // isMonthlyIntroNudgeCandidate, which runs the same first-cycle check. This
  // function is only index hygiene, and loadCandidates is bounded (monthly,
  // active, unsent, created within the max age, period end inside the scan
  // window), so declining to retire costs a slightly larger batch, nothing
  // more.
  return row.tier !== "starter" && row.tier !== "standard";
}

/**
 * Eligible when now is inside [periodEnd - 5 business days, periodEnd).
 */
export function isMonthlyIntroNudgeDue(periodEndAt: string, now: Date): boolean {
  const periodEndMs = Date.parse(periodEndAt);
  if (!Number.isFinite(periodEndMs)) return false;
  const nowMs = now.getTime();
  if (nowMs >= periodEndMs) return false;
  const windowStart = subtractBusinessDays(new Date(periodEndMs), MONTHLY_INTRO_NUDGE_BUSINESS_DAYS);
  return nowMs >= windowStart.getTime();
}

export function isMonthlyIntroNudgeCandidate(
  row: MonthlyIntroNudgeCandidate,
  now: Date
): boolean {
  if (row.billing_period !== "monthly") return false;
  if (row.status !== "active") return false;
  if (row.cancel_at_period_end) return false;
  if (row.billing_paused) return false;
  if (row.monthly_intro_nudge_sent_at) return false;
  if (row.tier !== "starter" && row.tier !== "standard") return false;
  if (!row.stripe_current_period_end) return false;
  if (!isFirstBillingCycle(row.created_at, row.stripe_current_period_start, now.getTime())) {
    return false;
  }
  return isMonthlyIntroNudgeDue(row.stripe_current_period_end, now);
}

async function loadCandidates(
  db: SupabaseClient,
  now: Date
): Promise<MonthlyIntroNudgeCandidate[]> {
  const nowIso = now.toISOString();
  const scanEnd = new Date(now.getTime() + MONTHLY_INTRO_NUDGE_SCAN_DAYS * 24 * 60 * 60 * 1000);
  const createdAfter = new Date(
    now.getTime() - MONTHLY_INTRO_NUDGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await db
    .from("subscriptions")
    .select(COLUMNS)
    .eq("billing_period", "monthly")
    .eq("status", "active")
    .is("monthly_intro_nudge_sent_at", null)
    .gte("created_at", createdAfter)
    .gt("stripe_current_period_end", nowIso)
    .lte("stripe_current_period_end", scanEnd.toISOString())
    .order("stripe_current_period_end", { ascending: true })
    .limit(MONTHLY_INTRO_NUDGE_BATCH_LIMIT);
  if (error) throw new Error(`loadMonthlyIntroNudgeCandidates: ${error.message}`);
  return (data ?? []) as unknown as MonthlyIntroNudgeCandidate[];
}

/**
 * Claim the nudge stamp. Returns true only if this caller won the race.
 */
export async function claimMonthlyIntroNudge(
  db: SupabaseClient,
  subscriptionId: string,
  sentAt: Date
): Promise<boolean> {
  const { data, error } = await db
    .from("subscriptions")
    .update({ monthly_intro_nudge_sent_at: sentAt.toISOString() })
    .eq("id", subscriptionId)
    .is("monthly_intro_nudge_sent_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`claimMonthlyIntroNudge: ${error.message}`);
  return data !== null;
}

export async function sweepMonthlyIntroNudges(
  deps: MonthlyIntroNudgeSweepDeps = {}
): Promise<MonthlyIntroNudgeSweepResult> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const send = deps.sendEmail ?? sendOwnerEmail;
  const resolveLocale = deps.resolveLocale ?? resolveOwnerUiLocaleForEmail;
  const getBusinessRow = deps.getBusinessRow ?? getBusiness;
  /* c8 ignore stop */
  const now = (deps.now ?? (() => new Date()))();
  const siteUrl = (deps.siteUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  const apiKey =
    deps.resendApiKey !== undefined ? deps.resendApiKey : (process.env.RESEND_API_KEY ?? null);

  const result: MonthlyIntroNudgeSweepResult = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    errors: []
  };

  const rows = await loadCandidates(db, now);
  result.scanned = rows.length;

  if (!apiKey) {
    logger.warn("monthly-intro-nudge: RESEND_API_KEY missing; skipping sends", {
      scanned: rows.length
    });
    result.skipped = rows.length;
    return result;
  }

  for (const row of rows) {
    try {
      if (!isMonthlyIntroNudgeCandidate(row, now)) {
        if (shouldRetireNudgeCandidate(row)) {
          // Drop renewed / non-intro tiers from the partial index so they
          // cannot starve first-month rows in later passes.
          await claimMonthlyIntroNudge(db, row.id, now);
        }
        result.skipped += 1;
        continue;
      }

      const business = await getBusinessRow(row.business_id, db);
      const toEmail = business?.owner_email?.trim() ?? "";
      if (!toEmail) {
        result.skipped += 1;
        logger.warn("monthly-intro-nudge: no owner email", {
          subscriptionId: row.id,
          businessId: row.business_id
        });
        continue;
      }

      // Claim before send so a crash cannot double-email.
      const claimed = await claimMonthlyIntroNudge(db, row.id, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      const locale = await resolveLocale(toEmail);
      const email = buildMonthlyIntroNudgeEmail({
        tier: row.tier as "starter" | "standard",
        periodEndAt: row.stripe_current_period_end!,
        recipientEmail: toEmail,
        siteUrl,
        locale
      });
      const messageId = await send(apiKey, toEmail, email.subject, {
        text: email.text,
        html: email.html
      });
      if (!messageId) {
        logger.warn("monthly-intro-nudge: send returned no message id", {
          subscriptionId: row.id,
          toEmail
        });
      }
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ subscriptionId: row.id, message });
      logger.error("monthly-intro-nudge: row failed", {
        subscriptionId: row.id,
        error: message
      });
    }
  }

  return result;
}
