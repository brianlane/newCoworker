/**
 * Permanent auth rejection for stored grants other than Calendly: persist
 * needs_reauth, stop using the dead token, and email the owner (once on the
 * flip, once more after a day if it is still broken, then stop).
 *
 * Calendly keeps src/lib/calendly/reauth.ts. This module is the shared loop
 * Zoom, Google, Microsoft 365, Acuity, CalDAV, Vagaro, Facebook, Slack, and
 * WhatsApp call. Transient 5xx never reaches markConnectionNeedsReauth.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordSystemLog } from "@/lib/db/system-logs";
import { logger } from "@/lib/logger";
import { buildConnectionReauthEmail } from "@/lib/email/templates/connection-reauth";
import {
  CONNECTION_REAUTH_KIND,
  CONNECTION_REAUTH_MAX_EMAILS,
  CONNECTION_REAUTH_REMINDER_MS,
  connectionPausedWork,
  connectionReauthBannerBody,
  connectionReconnectPath,
  formatConnectionLastHealthy,
  labelsForReauthRow,
  type ConnectionReauthProviderLabel,
  type ConnectionReauthTable
} from "@/lib/connections/reauth-copy";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

const REAUTH_EMAIL_COLUMNS =
  "id,business_id,last_healthy_at,reauth_email_count,reauth_email_last_sent_at,needs_reauth";

type ReauthEmailRow = {
  id: string;
  business_id: string;
  last_healthy_at: string | null;
  reauth_email_count: number | null;
  reauth_email_last_sent_at: string | null;
  needs_reauth: boolean;
  account_name?: string | null;
  account_email?: string | null;
  page_name?: string | null;
  team_name?: string | null;
  username?: string | null;
  calendar_name?: string | null;
  display_phone_number?: string | null;
  user_id?: string | null;
  client_id?: string | null;
  metadata?: Record<string, unknown> | null;
  provider_config_key?: string | null;
};

export type ConnectionReauthDeps = {
  client?: SupabaseClient;
  dispatch?: typeof dispatchUrgentNotification;
  now?: () => number;
};

export type MarkConnectionNeedsReauthResult = {
  /** True only on the healthy → needs_reauth transition. */
  flipped: boolean;
  emailed: boolean;
};

type ConnectionReauthBannerItem = {
  id: string;
  table: ConnectionReauthTable;
  provider: ConnectionReauthProviderLabel;
  accountLabel: string;
  lastHealthyLabel: string | null;
  reconnectPath: string;
  bannerBody: string;
  pausedWork: string;
};

const TABLE_SELECT: Record<ConnectionReauthTable, string> = {
  workspace_oauth_connections:
    `${REAUTH_EMAIL_COLUMNS},provider_config_key,metadata`,
  zoom_connections: `${REAUTH_EMAIL_COLUMNS},account_name,account_email`,
  acuity_connections: `${REAUTH_EMAIL_COLUMNS},user_id`,
  caldav_connections: `${REAUTH_EMAIL_COLUMNS},username,calendar_name`,
  vagaro_connections: `${REAUTH_EMAIL_COLUMNS},client_id`,
  meta_connections: `${REAUTH_EMAIL_COLUMNS},page_name,account_name`,
  slack_connections: `${REAUTH_EMAIL_COLUMNS},team_name`,
  whatsapp_connections: `${REAUTH_EMAIL_COLUMNS},display_phone_number`
};

const ALL_REAUTH_TABLES: ConnectionReauthTable[] = [
  "workspace_oauth_connections",
  "zoom_connections",
  "acuity_connections",
  "caldav_connections",
  "vagaro_connections",
  "meta_connections",
  "slack_connections",
  "whatsapp_connections"
];

function emailCount(row: Pick<ReauthEmailRow, "reauth_email_count">): number {
  const n = row.reauth_email_count;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function bannerItem(
  table: ConnectionReauthTable,
  row: ReauthEmailRow
): ConnectionReauthBannerItem {
  const labels = labelsForReauthRow(table, row);
  const lastHealthyLabel = formatConnectionLastHealthy(row.last_healthy_at);
  const pausedWork = connectionPausedWork(labels.provider);
  return {
    id: row.id,
    table,
    provider: labels.provider,
    accountLabel: labels.accountLabel,
    lastHealthyLabel,
    reconnectPath: connectionReconnectPath(labels.slug, row.id),
    pausedWork,
    bannerBody: connectionReauthBannerBody({
      provider: labels.provider,
      accountLabel: labels.accountLabel,
      lastHealthyLabel
    })
  };
}

async function sendReauthEmail(
  table: ConnectionReauthTable,
  row: ReauthEmailRow,
  deps: ConnectionReauthDeps
): Promise<boolean> {
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;
  const labels = labelsForReauthRow(table, row);
  const lastHealthyLabel = formatConnectionLastHealthy(row.last_healthy_at);
  const copy = buildConnectionReauthEmail({
    provider: labels.provider,
    accountLabel: labels.accountLabel,
    connectionId: row.id,
    slug: labels.slug,
    lastHealthyLabel
  });
  try {
    const result = await dispatch({
      businessId: row.business_id,
      kind: CONNECTION_REAUTH_KIND,
      summary: copy.summaryLine,
      smsBody: copy.smsBody,
      ctaPath: copy.ctaPath,
      ctaLabel: copy.ctaLabel,
      payload: {
        connection_id: row.id,
        table,
        provider: labels.provider,
        account_label: labels.accountLabel
      },
      emailTemplate: (locale) => {
        const localized = buildConnectionReauthEmail({
          provider: labels.provider,
          accountLabel: labels.accountLabel,
          connectionId: row.id,
          slug: labels.slug,
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
    return result.results.length > 0;
  } catch (err) {
    logger.warn("connection reauth email failed", {
      table,
      businessId: row.business_id,
      connectionId: row.id,
      error: String(err)
    });
    return false;
  }
}

async function stampEmailSent(
  db: SupabaseClient,
  table: ConnectionReauthTable,
  row: ReauthEmailRow,
  nextCount: number,
  nowIso: string
): Promise<void> {
  const { data, error } = await db
    .from(table)
    .update({
      reauth_email_count: nextCount,
      reauth_email_last_sent_at: nowIso,
      updated_at: nowIso
    })
    .eq("id", row.id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`stampConnectionReauthEmail: ${error.message}`);
  if (!data) {
    throw new Error(`stampConnectionReauthEmail: no row updated for ${row.id}`);
  }
}

/**
 * Flip THIS connection to needs_reauth and send the first product email.
 * Idempotent: a row that is already flagged is left alone (no extra email).
 * A transient 5xx never calls this.
 */
export async function markConnectionNeedsReauth(
  table: ConnectionReauthTable,
  connectionId: string,
  deps: ConnectionReauthDeps = {}
): Promise<MarkConnectionNeedsReauthResult> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const columns = TABLE_SELECT[table];

  const { data: existing, error: readError } = await db
    .from(table)
    .select(columns)
    .eq("id", connectionId)
    .maybeSingle();
  if (readError) {
    throw new Error(`markConnectionNeedsReauth: ${readError.message}`);
  }
  if (!existing) {
    return { flipped: false, emailed: false };
  }
  const row = existing as unknown as ReauthEmailRow;
  if (row.needs_reauth) {
    return { flipped: false, emailed: false };
  }

  const { data: updated, error: writeError } = await db
    .from(table)
    .update({
      needs_reauth: true,
      updated_at: nowIso
    })
    .eq("id", connectionId)
    .eq("needs_reauth", false)
    .select(columns)
    .maybeSingle();
  if (writeError) {
    throw new Error(`markConnectionNeedsReauth: ${writeError.message}`);
  }
  if (!updated) {
    return { flipped: false, emailed: false };
  }
  const flagged = updated as unknown as ReauthEmailRow;
  const labels = labelsForReauthRow(table, flagged);

  await recordSystemLog({
    businessId: flagged.business_id,
    source: "aiflow",
    level: "warn",
    event: `${labels.slug}_connection_needs_reauth`,
    message: `${labels.provider} connection ${labels.accountLabel} needs a reconnect`,
    payload: {
      connection_id: flagged.id,
      table,
      provider: labels.provider
    }
  });

  if (emailCount(flagged) >= CONNECTION_REAUTH_MAX_EMAILS) {
    return { flipped: true, emailed: false };
  }

  const emailed = await sendReauthEmail(table, flagged, deps);
  if (emailed) {
    await stampEmailSent(db, table, flagged, emailCount(flagged) + 1, nowIso);
  }
  return { flipped: true, emailed };
}

/**
 * Stamp last_healthy_at on a successful call of THIS connection.
 * Never writes on a needs_reauth row (the dead grant is not healthy).
 */
export async function stampConnectionHealthy(
  table: ConnectionReauthTable,
  connectionId: string,
  deps: ConnectionReauthDeps = {}
): Promise<void> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const { data, error } = await db
    .from(table)
    .update({ last_healthy_at: nowIso, updated_at: nowIso })
    .eq("id", connectionId)
    .eq("needs_reauth", false)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`stampConnectionHealthy: ${error.message}`);
  if (!data) return;
}

/**
 * Second (and final) product email for rows still flagged after a day.
 * Called from the calendar-poll cron tick so it runs even when pollers
 * skip the dead token.
 */
export async function processConnectionReauthReminders(
  deps: ConnectionReauthDeps = {}
): Promise<{ considered: number; emailed: number }> {
  const db = deps.client ?? (await createSupabaseServiceClient());
  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - CONNECTION_REAUTH_REMINDER_MS).toISOString();

  let considered = 0;
  let emailed = 0;
  for (const table of ALL_REAUTH_TABLES) {
    const { data, error } = await db
      .from(table)
      .select(TABLE_SELECT[table])
      .eq("needs_reauth", true)
      .lt("reauth_email_count", CONNECTION_REAUTH_MAX_EMAILS)
      .or(
        // Inclusive: JS due-check is `now - lastSent >= REMINDER_MS`. `.lt`
        // dropped a last_sent stamped exactly 24h ago (CI itest).
        `reauth_email_last_sent_at.is.null,reauth_email_last_sent_at.lte."${cutoffIso}"`
      )
      .limit(100);
    if (error) throw new Error(`processConnectionReauthReminders: ${error.message}`);
    const rows = (data ?? []) as unknown as ReauthEmailRow[];
    considered += rows.length;
    for (const row of rows) {
      const count = emailCount(row);
      if (count >= CONNECTION_REAUTH_MAX_EMAILS) continue;
      const lastSentMs = row.reauth_email_last_sent_at
        ? Date.parse(row.reauth_email_last_sent_at)
        : Number.NaN;
      const due =
        count === 0 ||
        !Number.isFinite(lastSentMs) ||
        now - lastSentMs >= CONNECTION_REAUTH_REMINDER_MS;
      if (!due) continue;
      const sent = await sendReauthEmail(table, row, deps);
      if (!sent) continue;
      await stampEmailSent(db, table, row, count + 1, nowIso);
      emailed += 1;
    }
  }
  return { considered, emailed };
}

/** Banner payload for every flagged non-Calendly connection on a business. */
export async function listConnectionReauthBannerState(
  businessId: string,
  client?: SupabaseClient
): Promise<ConnectionReauthBannerItem[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const banners: ConnectionReauthBannerItem[] = [];
  for (const table of ALL_REAUTH_TABLES) {
    const { data, error } = await db
      .from(table)
      .select(TABLE_SELECT[table])
      .eq("business_id", businessId)
      .eq("needs_reauth", true)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(`listConnectionReauthBannerState: ${error.message}`);
    for (const row of (data ?? []) as unknown as ReauthEmailRow[]) {
      banners.push(bannerItem(table, row));
    }
  }
  return banners;
}
