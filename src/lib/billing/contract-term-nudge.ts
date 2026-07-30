/**
 * Daily sweep: one polite email to annual/biennial owners with contract
 * auto-renew OFF, 5 business days before term end (rollover to month-to-month).
 *
 * Idempotence: `contract_term_nudge_sent_at` is stamped BEFORE the send, so
 * an overlapping tick or a crash mid-send can never double-email. Prefer a
 * missed nudge over a duplicate.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import { isCommitmentElapsed } from "@/lib/db/subscriptions";
import { subtractBusinessDays } from "@/lib/datetime/business-days";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildContractTermNudgeEmail } from "@/lib/email/templates/contract-term-nudge";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How far ahead of period_end the scan looks (covers 5 biz days + weekend slack). */
export const CONTRACT_TERM_NUDGE_SCAN_DAYS = 10;

/** Lead time before period end, in business days. */
export const CONTRACT_TERM_NUDGE_BUSINESS_DAYS = 5;

/** Per-pass ceiling so one busy day cannot starve the rest of the fleet. */
export const CONTRACT_TERM_NUDGE_BATCH_LIMIT = 200;

export type ContractTermNudgeCandidate = {
  id: string;
  business_id: string;
  tier: PlanTier;
  status: string;
  billing_period: BillingPeriod | null;
  cancel_at_period_end: boolean;
  billing_paused: boolean;
  contract_auto_renew: boolean;
  renewal_at: string | null;
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
  contract_term_nudge_sent_at: string | null;
};

const COLUMNS =
  "id,business_id,tier,status,billing_period,cancel_at_period_end,billing_paused," +
  "contract_auto_renew,renewal_at,stripe_current_period_start,stripe_current_period_end," +
  "contract_term_nudge_sent_at";

export type ContractTermNudgeSweepDeps = {
  client?: SupabaseClient;
  sendEmail?: typeof sendOwnerEmail;
  resolveLocale?: typeof resolveOwnerUiLocaleForEmail;
  getBusinessRow?: typeof getBusiness;
  now?: () => Date;
  siteUrl?: string;
  resendApiKey?: string | null;
};

export type ContractTermNudgeSweepResult = {
  scanned: number;
  sent: number;
  skipped: number;
  errors: Array<{ subscriptionId: string; message: string }>;
};

function isTermPeriod(
  period: BillingPeriod | null
): period is Exclude<BillingPeriod, "monthly"> {
  return period === "annual" || period === "biennial";
}

/**
 * Rows that will never become eligible. Stamp them so they leave the partial
 * index. Temporary states (paused, cancel-at-period-end, not-yet-in-window)
 * stay unstamped so a later pass can still send.
 */
export function shouldRetireContractTermNudgeCandidate(
  row: ContractTermNudgeCandidate,
  now: Date
): boolean {
  if (row.tier !== "starter" && row.tier !== "standard") return true;
  if (!isTermPeriod(row.billing_period)) return true;
  if (row.contract_auto_renew) return true;
  if (isCommitmentElapsed(row, now)) return true;
  return false;
}

/** Eligible when now is inside [periodEnd - 5 business days, periodEnd). */
export function isContractTermNudgeDue(periodEndAt: string, now: Date): boolean {
  const periodEndMs = Date.parse(periodEndAt);
  if (!Number.isFinite(periodEndMs)) return false;
  const nowMs = now.getTime();
  if (nowMs >= periodEndMs) return false;
  const windowStart = subtractBusinessDays(new Date(periodEndMs), CONTRACT_TERM_NUDGE_BUSINESS_DAYS);
  return nowMs >= windowStart.getTime();
}

export function isContractTermNudgeCandidate(
  row: ContractTermNudgeCandidate,
  now: Date
): boolean {
  if (!isTermPeriod(row.billing_period)) return false;
  if (row.status !== "active") return false;
  if (row.contract_auto_renew) return false;
  if (row.cancel_at_period_end) return false;
  if (row.billing_paused) return false;
  if (row.contract_term_nudge_sent_at) return false;
  if (row.tier !== "starter" && row.tier !== "standard") return false;
  if (!row.stripe_current_period_end) return false;
  if (isCommitmentElapsed(row, now)) return false;
  return isContractTermNudgeDue(row.stripe_current_period_end, now);
}

async function loadCandidates(
  db: SupabaseClient,
  now: Date
): Promise<ContractTermNudgeCandidate[]> {
  const nowIso = now.toISOString();
  const scanEnd = new Date(now.getTime() + CONTRACT_TERM_NUDGE_SCAN_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await db
    .from("subscriptions")
    .select(COLUMNS)
    .in("billing_period", ["annual", "biennial"])
    .eq("status", "active")
    .eq("contract_auto_renew", false)
    .is("contract_term_nudge_sent_at", null)
    .gt("stripe_current_period_end", nowIso)
    .lte("stripe_current_period_end", scanEnd.toISOString())
    .order("stripe_current_period_end", { ascending: true })
    .limit(CONTRACT_TERM_NUDGE_BATCH_LIMIT);
  if (error) throw new Error(`loadContractTermNudgeCandidates: ${error.message}`);
  return (data ?? []) as unknown as ContractTermNudgeCandidate[];
}

/**
 * Claim the nudge stamp. Returns true only if this caller won the race.
 */
export async function claimContractTermNudge(
  db: SupabaseClient,
  subscriptionId: string,
  sentAt: Date
): Promise<boolean> {
  const { data, error } = await db
    .from("subscriptions")
    .update({ contract_term_nudge_sent_at: sentAt.toISOString() })
    .eq("id", subscriptionId)
    .is("contract_term_nudge_sent_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`claimContractTermNudge: ${error.message}`);
  return data !== null;
}

export async function sweepContractTermNudges(
  deps: ContractTermNudgeSweepDeps = {}
): Promise<ContractTermNudgeSweepResult> {
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

  const result: ContractTermNudgeSweepResult = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    errors: []
  };

  const rows = await loadCandidates(db, now);
  result.scanned = rows.length;

  if (!apiKey) {
    logger.warn("contract-term-nudge: RESEND_API_KEY missing; skipping sends", {
      scanned: rows.length
    });
    result.skipped = rows.length;
    return result;
  }

  for (const row of rows) {
    try {
      if (!isContractTermNudgeCandidate(row, now)) {
        if (shouldRetireContractTermNudgeCandidate(row, now)) {
          await claimContractTermNudge(db, row.id, now);
        }
        result.skipped += 1;
        continue;
      }

      const business = await getBusinessRow(row.business_id, db);
      const toEmail = business?.owner_email?.trim() ?? "";
      if (!toEmail) {
        result.skipped += 1;
        logger.warn("contract-term-nudge: no owner email", {
          subscriptionId: row.id,
          businessId: row.business_id
        });
        continue;
      }

      const claimed = await claimContractTermNudge(db, row.id, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      const locale = await resolveLocale(toEmail);
      const billingPeriod = row.billing_period as Exclude<BillingPeriod, "monthly">;
      const email = buildContractTermNudgeEmail({
        tier: row.tier as "starter" | "standard",
        billingPeriod,
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
        logger.warn("contract-term-nudge: send returned no message id", {
          subscriptionId: row.id,
          toEmail
        });
      }
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ subscriptionId: row.id, message });
      logger.error("contract-term-nudge: row failed", {
        subscriptionId: row.id,
        error: message
      });
    }
  }

  return result;
}
