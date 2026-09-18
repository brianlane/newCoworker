/**
 * Permanent Calendly auth rejection: persist needs_reauth, stop using the
 * dead token, and email the owner (once on the flip, once more after a day
 * if it is still broken, then stop).
 *
 * Calendly in this product is a pasted Personal Access Token, not OAuth.
 * Google/Microsoft already deactivate on invalid_grant in their own token
 * managers; they do not share this path. This module is Calendly-only.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import { buildCalendlyReauthEmail } from "@/lib/email/templates/calendly-reauth";
import {
  calendlyAccountLabel,
  calendlyReauthBannerBody,
  calendlyReconnectPath,
  formatCalendlyLastHealthy
} from "@/lib/calendly/reauth-copy";

export {
  CALENDLY_CALENDAR_PAUSED_COPY,
  calendlyAccountLabel,
  calendlyCalendarPausedCopy,
  calendlyReauthBannerBody,
  calendlyReconnectPath,
  flowHasCalendarTrigger,
  formatCalendlyLastHealthy,
  isCalendlyTokenRejected
} from "@/lib/calendly/reauth-copy";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** notifications.kind for the product email + dashboard row. */
export const CALENDLY_REAUTH_KIND = "calendly_needs_reauth";

/** Once on the flip, once more after a day, then never. */
export const CALENDLY_REAUTH_MAX_EMAILS = 2;

export const CALENDLY_REAUTH_REMINDER_MS = 24 * 60 * 60 * 1000;

const REAUTH_EMAIL_COLUMNS =
  "id,business_id,account_name,account_email,last_healthy_at," +
  "reauth_email_count,reauth_email_last_sent_at,needs_reauth";

type ReauthEmailRow = {
  id: string;
  business_id: string;
  account_name: string | null;
  account_email: string | null;
  last_healthy_at: string | null;
  reauth_email_count: number | null;
  reauth_email_last_sent_at: string | null;
  needs_reauth: boolean;
};

export type CalendlyReauthDeps = {
  client?: SupabaseClient;
  dispatch?: typeof dispatchUrgentNotification;
  now?: () => number;
};

export type MarkCalendlyNeedsReauthResult = {
  /** True only on the healthy → needs_reauth transition. */
  flipped: boolean;
  emailed: boolean;
};

function emailCount(row: Pick<ReauthEmailRow, "reauth_email_count">): number {
  const n = row.reauth_email_count;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

async function sendReauthEmail(
  row: ReauthEmailRow,
  deps: CalendlyReauthDeps
): Promise<boolean> {
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;
  const accountLabel = calendlyAccountLabel(row);
  const lastHealthyLabel = formatCalendlyLastHealthy(row.last_healthy_at);
  const copy = buildCalendlyReauthEmail({
    accountLabel,
    connectionId: row.id,
    lastHealthyLabel
  });
  try {
    const result = await dispatch({
      businessId: row.business_id,
      kind: CALENDLY_REAUTH_KIND,
      summary: copy.summaryLine,
      smsBody: copy.smsBody,
      ctaPath: copy.ctaPath,
      ctaLabel: copy.ctaLabel,
      payload: {
        connection_id: row.id,
        account_email: row.account_email,
        account_name: row.account_name
      },
      emailTemplate: (locale) => {
        const localized = buildCalendlyReauthEmail({
          accountLabel,
          connectionId: row.id,
          lastHealthyLabel,
          locale
        });
        return {
          subject: localized.subject,
          heading: localized.heading,
          body: localized.body,
          ctaLabel: localized.ctaLabel,
          ctaPath: localized.ctaPath
        };
      }
    });
    // Any channel row (email, dashboard, SMS) counts: James's owner
    // channel is email + dashboard, and a written dashboard notification
    // is still a delivered product notice even if SMS is off.
    return result.results.length > 0;
  } catch (err) {
    logger.warn("calendly reauth email failed", {
      businessId: row.business_id,
      connectionId: row.id,
      error: String(err)
    });
    return false;
  }
}

async function stampEmailSent(
  db: SupabaseClient,
  row: ReauthEmailRow,
  nextCount: number,
  nowIso: string
): Promise<void> {
  const { data, error } = await db
    .from("calendly_connections")
    .update({
      reauth_email_count: nextCount,
      reauth_email_last_sent_at: nowIso,
      updated_at: nowIso
    })
    .eq("id", row.id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`stampCalendlyReauthEmail: ${error.message}`);
  if (!data) {
    throw new Error(`stampCalendlyReauthEmail: no row updated for ${row.id}`);
  }
}

/**
 * Flip THIS connection to needs_reauth and send the first product email.
 * Idempotent: a row that is already flagged is left alone (no extra email).
 * A transient 5xx never calls this; only calendly_token_rejected does.
 */
export async function markCalendlyConnectionNeedsReauth(
  connectionId: string,
  deps: CalendlyReauthDeps = {}
): Promise<MarkCalendlyNeedsReauthResult> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();

  const { data: existing, error: readError } = await db
    .from("calendly_connections")
    .select(REAUTH_EMAIL_COLUMNS)
    .eq("id", connectionId)
    .maybeSingle();
  if (readError) {
    throw new Error(`markCalendlyConnectionNeedsReauth: ${readError.message}`);
  }
  if (!existing) {
    return { flipped: false, emailed: false };
  }
  const row = existing as unknown as ReauthEmailRow;
  if (row.needs_reauth) {
    return { flipped: false, emailed: false };
  }

  const { data: updated, error: writeError } = await db
    .from("calendly_connections")
    .update({
      needs_reauth: true,
      updated_at: nowIso
    })
    .eq("id", connectionId)
    .eq("needs_reauth", false)
    .select(REAUTH_EMAIL_COLUMNS)
    .maybeSingle();
  if (writeError) {
    throw new Error(`markCalendlyConnectionNeedsReauth: ${writeError.message}`);
  }
  if (!updated) {
    // Lost the race with another poller: the row is already flagged.
    return { flipped: false, emailed: false };
  }
  const flagged = updated as unknown as ReauthEmailRow;

  await recordSystemLog({
    businessId: flagged.business_id,
    source: "aiflow",
    level: "warn",
    event: "calendly_connection_needs_reauth",
    message: `Calendly connection ${calendlyAccountLabel(flagged)} needs a reconnect`,
    payload: {
      connection_id: flagged.id,
      account_email: flagged.account_email
    }
  });

  if (emailCount(flagged) >= CALENDLY_REAUTH_MAX_EMAILS) {
    return { flipped: true, emailed: false };
  }

  const emailed = await sendReauthEmail(flagged, deps);
  if (emailed) {
    await stampEmailSent(db, flagged, emailCount(flagged) + 1, nowIso);
  }
  return { flipped: true, emailed };
}

/**
 * Stamp last_healthy_at on a successful poll/sweep of THIS connection.
 * Never writes on a needs_reauth row (the dead token is not healthy).
 */
export async function stampCalendlyConnectionHealthy(
  connectionId: string,
  deps: CalendlyReauthDeps = {}
): Promise<void> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const { data, error } = await db
    .from("calendly_connections")
    .update({ last_healthy_at: nowIso, updated_at: nowIso })
    .eq("id", connectionId)
    .eq("needs_reauth", false)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`stampCalendlyConnectionHealthy: ${error.message}`);
  if (!data) return;
}

/**
 * Second (and final) product email for rows still flagged after a day.
 * Called from the calendar-poll cron tick so it runs even when the poller
 * is skipping the dead token.
 */
export async function processCalendlyReauthReminders(
  deps: CalendlyReauthDeps = {}
): Promise<{ considered: number; emailed: number }> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - CALENDLY_REAUTH_REMINDER_MS).toISOString();

  const { data, error } = await db
    .from("calendly_connections")
    .select(REAUTH_EMAIL_COLUMNS)
    .eq("needs_reauth", true)
    .lt("reauth_email_count", CALENDLY_REAUTH_MAX_EMAILS)
    .or(
      `reauth_email_last_sent_at.is.null,reauth_email_last_sent_at.lt."${cutoffIso}"`
    )
    .limit(100);
  if (error) throw new Error(`processCalendlyReauthReminders: ${error.message}`);

  const rows = (data ?? []) as unknown as ReauthEmailRow[];
  let emailed = 0;
  for (const row of rows) {
    const count = emailCount(row);
    if (count >= CALENDLY_REAUTH_MAX_EMAILS) continue;
    const lastSentMs = row.reauth_email_last_sent_at
      ? Date.parse(row.reauth_email_last_sent_at)
      : Number.NaN;
    const due =
      count === 0 ||
      !Number.isFinite(lastSentMs) ||
      now - lastSentMs >= CALENDLY_REAUTH_REMINDER_MS;
    if (!due) continue;
    const sent = await sendReauthEmail(row, deps);
    if (!sent) continue;
    await stampEmailSent(db, row, count + 1, nowIso);
    emailed += 1;
  }
  return { considered: rows.length, emailed };
}

/** Banner payload for every flagged connection on a business. */
export async function listCalendlyReauthBannerState(
  businessId: string,
  client?: SupabaseClient
): Promise<
  Array<{
    id: string;
    accountLabel: string;
    lastHealthyLabel: string | null;
    reconnectPath: string;
    bannerBody: string;
  }>
> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("calendly_connections")
    .select(
      "id,account_name,account_email,last_healthy_at,needs_reauth,is_active"
    )
    .eq("business_id", businessId)
    .eq("needs_reauth", true)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`listCalendlyReauthBannerState: ${error.message}`);
  return ((data ?? []) as Array<{
    id: string;
    account_name: string | null;
    account_email: string | null;
    last_healthy_at: string | null;
  }>).map((row) => {
    const accountLabel = calendlyAccountLabel(row);
    const lastHealthyLabel = formatCalendlyLastHealthy(row.last_healthy_at);
    return {
      id: row.id,
      accountLabel,
      lastHealthyLabel,
      reconnectPath: calendlyReconnectPath(row.id),
      bannerBody: calendlyReauthBannerBody({ accountLabel, lastHealthyLabel })
    };
  });
}

