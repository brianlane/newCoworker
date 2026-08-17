/**
 * Daily sweep: one email to owners whose priority support is about to lapse.
 *
 * Only tenants who will actually LOSE coverage get it. A renewing $400/month
 * subscription is not about to lapse, so those rows are skipped: the target is
 * a canceled subscription winding down, or an admin-comped window running out.
 *
 * Idempotence: `businesses.priority_support_nudge_sent_at` is stamped BEFORE
 * the send, so an overlapping tick or a crash mid-send can never double-email.
 * Prefer a missed nudge over a duplicate. The stamp is cleared whenever a new
 * coverage window opens (see clearPrioritySupportNudgeStamp), so a tenant who
 * lapses, restarts, and lapses again is warned each time.
 *
 * Modeled on contract-term-nudge.ts, including the claim-then-send ordering
 * and the injected-deps shape that makes the whole thing unit-testable.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { subtractBusinessDays } from "@/lib/datetime/business-days";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildPrioritySupportNudgeEmail } from "@/lib/email/templates/priority-support-nudge";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { prioritySupportDaysLeft } from "@/lib/plans/priority-support";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How far ahead of the coverage end the scan looks (covers the lead time plus weekend slack). */
export const PRIORITY_SUPPORT_NUDGE_SCAN_DAYS = 10;

/** Lead time before coverage ends, in business days. */
export const PRIORITY_SUPPORT_NUDGE_BUSINESS_DAYS = 5;

/** Per-pass ceiling so one busy day cannot starve the rest of the fleet. */
export const PRIORITY_SUPPORT_NUDGE_BATCH_LIMIT = 200;

export type PrioritySupportNudgeCandidate = {
  id: string;
  owner_email: string | null;
  tier: string | null;
  timezone: string | null;
  priority_support_until: string | null;
  priority_support_nudge_sent_at: string | null;
};

const COLUMNS =
  "id,owner_email,tier,timezone,priority_support_until,priority_support_nudge_sent_at";

export type PrioritySupportNudgeSweepResult = {
  scanned: number;
  sent: number;
  skipped: number;
  errors: Array<{ businessId: string; message: string }>;
};

export type PrioritySupportNudgeSweepDeps = {
  client?: SupabaseClient;
  sendEmail?: typeof sendOwnerEmail;
  resolveLocale?: typeof resolveOwnerUiLocaleForEmail;
  /** Business ids with a still-renewing subscription; those never get warned. */
  listRenewingBusinessIds?: (db: SupabaseClient) => Promise<Set<string>>;
  now?: () => Date;
  siteUrl?: string;
  resendApiKey?: string | null;
};

/** Eligible when now is inside [coverageEnd - 5 business days, coverageEnd). */
export function isPrioritySupportNudgeDue(coverageEndsAt: string, now: Date): boolean {
  const endMs = Date.parse(coverageEndsAt);
  if (!Number.isFinite(endMs)) return false;
  const nowMs = now.getTime();
  if (nowMs >= endMs) return false;
  const windowStart = subtractBusinessDays(
    new Date(endMs),
    PRIORITY_SUPPORT_NUDGE_BUSINESS_DAYS
  );
  return nowMs >= windowStart.getTime();
}

export function isPrioritySupportNudgeCandidate(
  row: PrioritySupportNudgeCandidate,
  now: Date,
  renewingBusinessIds: ReadonlySet<string>
): boolean {
  // Enterprise coverage is permanent, so it can never be "about to lapse".
  if (row.tier === "enterprise") return false;
  if (!row.priority_support_until) return false;
  if (row.priority_support_nudge_sent_at) return false;
  // A renewing subscription pushes the window forward on every paid invoice.
  if (renewingBusinessIds.has(row.id)) return false;
  return isPrioritySupportNudgeDue(row.priority_support_until, now);
}

async function loadCandidates(
  db: SupabaseClient,
  now: Date
): Promise<PrioritySupportNudgeCandidate[]> {
  const nowIso = now.toISOString();
  const scanEnd = new Date(
    now.getTime() + PRIORITY_SUPPORT_NUDGE_SCAN_DAYS * 24 * 60 * 60 * 1000
  );
  const { data, error } = await db
    .from("businesses")
    .select(COLUMNS)
    .is("priority_support_nudge_sent_at", null)
    .gt("priority_support_until", nowIso)
    .lte("priority_support_until", scanEnd.toISOString())
    .order("priority_support_until", { ascending: true })
    .limit(PRIORITY_SUPPORT_NUDGE_BATCH_LIMIT);
  if (error) throw new Error(`loadPrioritySupportNudgeCandidates: ${error.message}`);
  return (data ?? []) as unknown as PrioritySupportNudgeCandidate[];
}

/** Business ids whose add-on is still renewing (so coverage is not ending). */
async function loadRenewingBusinessIds(db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db
    .from("priority_support_subscriptions")
    .select("business_id")
    .eq("status", "active")
    .eq("cancel_at_period_end", false)
    .limit(PRIORITY_SUPPORT_NUDGE_BATCH_LIMIT);
  if (error) throw new Error(`loadRenewingPrioritySupport: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { business_id: string }).business_id));
}

/** Claim the nudge stamp. Returns true only if this caller won the race. */
export async function claimPrioritySupportNudge(
  db: SupabaseClient,
  businessId: string,
  sentAt: Date
): Promise<boolean> {
  const { data, error } = await db
    .from("businesses")
    .update({ priority_support_nudge_sent_at: sentAt.toISOString() })
    .eq("id", businessId)
    .is("priority_support_nudge_sent_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`claimPrioritySupportNudge: ${error.message}`);
  return data !== null;
}

export async function sweepPrioritySupportNudges(
  deps: PrioritySupportNudgeSweepDeps = {}
): Promise<PrioritySupportNudgeSweepResult> {
  /* c8 ignore start -- production defaults; unit tests inject deps */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const send = deps.sendEmail ?? sendOwnerEmail;
  const resolveLocale = deps.resolveLocale ?? resolveOwnerUiLocaleForEmail;
  const listRenewing = deps.listRenewingBusinessIds ?? loadRenewingBusinessIds;
  /* c8 ignore stop */
  const now = (deps.now ?? (() => new Date()))();
  const siteUrl = (
    deps.siteUrl ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const apiKey =
    deps.resendApiKey !== undefined ? deps.resendApiKey : (process.env.RESEND_API_KEY ?? null);

  const result: PrioritySupportNudgeSweepResult = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    errors: []
  };

  const rows = await loadCandidates(db, now);
  result.scanned = rows.length;

  if (!apiKey) {
    logger.warn("priority-support-nudge: RESEND_API_KEY missing; skipping sends", {
      scanned: rows.length
    });
    result.skipped = rows.length;
    return result;
  }

  const renewing = rows.length > 0 ? await listRenewing(db) : new Set<string>();

  for (const row of rows) {
    try {
      if (!isPrioritySupportNudgeCandidate(row, now, renewing)) {
        result.skipped += 1;
        continue;
      }

      const toEmail = row.owner_email?.trim() ?? "";
      if (!toEmail) {
        result.skipped += 1;
        logger.warn("priority-support-nudge: no owner email", { businessId: row.id });
        continue;
      }

      const daysLeft = prioritySupportDaysLeft(row.tier, row.priority_support_until, now);
      /* c8 ignore start -- unreachable belt-and-braces: the candidate gate
         above already excludes enterprise, null windows, and unparseable
         dates, which are the only three inputs that return null here. Kept so
         a future relaxation of that gate cannot send "NaN days" to a customer. */
      if (daysLeft === null) {
        result.skipped += 1;
        continue;
      }
      /* c8 ignore stop */

      const claimed = await claimPrioritySupportNudge(db, row.id, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      const locale = await resolveLocale(toEmail);
      const email = buildPrioritySupportNudgeEmail({
        coverageEndsAt: row.priority_support_until!,
        daysLeft,
        recipientEmail: toEmail,
        siteUrl,
        locale,
        ...(row.timezone ? { timeZone: row.timezone } : {})
      });
      const messageId = await send(apiKey, toEmail, email.subject, {
        text: email.text,
        html: email.html
      });
      if (!messageId) {
        logger.warn("priority-support-nudge: send returned no message id", {
          businessId: row.id,
          toEmail
        });
      }
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ businessId: row.id, message });
      logger.error("priority-support-nudge: row failed", {
        businessId: row.id,
        error: message
      });
    }
  }

  return result;
}
