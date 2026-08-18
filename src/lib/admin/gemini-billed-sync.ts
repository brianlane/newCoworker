/**
 * Gemini billed-actuals sync — Google's side of the metered-vs-billed
 * reconciliation on the admin Gemini page.
 *
 * Google exposes NO direct spend API for the Gemini API (AI Studio's
 * billing page is UI-only); the supported programmatic path is the Cloud
 * Billing export to BigQuery. This module runs one aggregate query per day
 * against that export — billed cost per UTC usage day + GCP project for
 * the Generative Language API — and replaces a rolling window of
 * `gemini_billed_daily` rows, mirroring the Telnyx cost sync's shape
 * (delete+insert in one transaction, status recorded in
 * admin_platform_settings).
 *
 * Until the operator finishes the one-time setup (billing export enabled,
 * service account key + export table env vars set — see
 * docs/GEMINI-SPEND.md) the sync records `configured: false` and skips
 * WITHOUT failing the surrounding platform-cost sync.
 *
 * All dependencies are injected; the runner wires production
 * implementations. Nothing here bills anyone — operator telemetry only.
 */

import type { GeminiBilledDailyInsert } from "@/lib/db/gemini-spend";

export const GEMINI_BILLED_SYNC_STATUS_KEY = "gemini_billed_sync_status";

/**
 * Default Cloud Billing `service.description` for Gemini API spend.
 *
 * Google labels this service "Gemini API" in the billing export, NOT
 * "Generative Language API" (the API's own endpoint name). The filter is an
 * exact string match, so the old value matched zero rows on every run from
 * setup until 2026-08-18: verified live against the export, where the only
 * Gemini service present is "Gemini API" ($60.88 over 30 days) and
 * "Generative Language API" returns 0 rows. Override with
 * GEMINI_BILLING_SERVICE_DESCRIPTION if Google renames it again.
 */
export const DEFAULT_GEMINI_BILLING_SERVICE = "Gemini API";

/**
 * Rolling sync window: must cover the WIDEST admin range (/admin/gemini's
 * 90-day view) plus lag headroom, so every billed day the UI can show is
 * rewritten on every sync — a narrower window would freeze older in-range
 * days at their last synced value while the metered side stays live.
 */
export const BILLED_SYNC_WINDOW_DAYS = 95;

export type GeminiBilledSyncStatus = {
  lastSyncAt: string;
  /** False when the BigQuery export env vars are absent (expected pre-setup). */
  configured: boolean;
  ok: boolean;
  rows: number;
  error: string | null;
  windowStartDay: string | null;
};

/** Parse the stored status jsonb; null when missing or unusable. */
export function parseGeminiBilledSyncStatus(raw: unknown): GeminiBilledSyncStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.lastSyncAt !== "string") return null;
  return {
    lastSyncAt: r.lastSyncAt,
    configured: r.configured === true,
    ok: r.ok === true,
    rows: typeof r.rows === "number" ? r.rows : 0,
    error: typeof r.error === "string" ? r.error : null,
    windowStartDay: typeof r.windowStartDay === "string" ? r.windowStartDay : null
  };
}

/**
 * Fully-qualified export table id, validated against BigQuery's
 * `project.dataset.table` charset so it can be safely inlined into the
 * query (BigQuery parameterizes values, not identifiers). Null → reject.
 */
export function validateExportTableId(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(trimmed) ? trimmed : null;
}

/**
 * The one aggregate statement of the sync: billed cost per UTC usage day +
 * project for the given service, from `windowStartDay` on. Inputs are
 * operator-controlled env values, still sanitized before inlining: the
 * table id is charset-validated ({@link validateExportTableId}), the
 * service name has quotes/backslashes escaped, and the window day is
 * produced by our own date math.
 */
export function buildBilledQuery(
  exportTableId: string,
  serviceDescription: string,
  windowStartDay: string
): string {
  const service = serviceDescription.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    "SELECT DATE(usage_start_time, 'UTC') AS day, project.id AS project_id, " +
    "SUM(cost) AS cost " +
    `FROM \`${exportTableId}\` ` +
    `WHERE service.description = '${service}' ` +
    `AND DATE(usage_start_time, 'UTC') >= '${windowStartDay}' ` +
    "GROUP BY day, project_id ORDER BY day, project_id"
  );
}

/**
 * Map BigQuery's stringly-typed result rows into insert rows. Rows with an
 * unparseable day or cost are dropped rather than guessed; a null project id
 * becomes "unknown" so the money still lands in the reconciliation total.
 */
export function billedRowsFromQuery(
  rows: Array<Record<string, string | null>>
): GeminiBilledDailyInsert[] {
  const out: GeminiBilledDailyInsert[] = [];
  for (const row of rows) {
    const day = row.day ?? "";
    // `?? NaN` (not `?? ""`): a null cost must DROP the row, not coerce to $0.
    const cost = Number(row.cost ?? NaN);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(cost)) continue;
    out.push({
      day,
      gcp_project_id: row.project_id ?? "unknown",
      cost_micros: Math.round(cost * 1_000_000)
    });
  }
  return out;
}

/** UTC YYYY-MM-DD for "today minus `days`". */
export function billedWindowStartDayUtc(now: Date, days: number = BILLED_SYNC_WINDOW_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type GeminiBilledSyncDeps = {
  /** Null when the operator hasn't finished setup — sync records a skip. */
  exportTableId: string | null;
  /** Billing `service.description` to filter on (default "Gemini API"). */
  serviceDescription?: string;
  /** Runs the aggregate query; null when the SA key env is absent/unusable. */
  runQuery:
    | ((query: string) => Promise<Array<Record<string, string | null>>>)
    | null;
  replaceGeminiBilledWindow: (
    windowStartDay: string,
    rows: GeminiBilledDailyInsert[]
  ) => Promise<void>;
  recordStatus: (status: GeminiBilledSyncStatus) => Promise<void>;
  now?: Date;
};

/** Run the billed sync, record + return the outcome. */
export async function runGeminiBilledSync(
  deps: GeminiBilledSyncDeps
): Promise<GeminiBilledSyncStatus> {
  const now = deps.now ?? new Date();
  const tableId = validateExportTableId(deps.exportTableId);
  const configured = tableId !== null && deps.runQuery !== null;

  let rows = 0;
  let error: string | null = null;
  let windowStartDay: string | null = null;
  if (!configured) {
    error =
      "not configured, set GCP_BILLING_SA_KEY_JSON + GCP_BILLING_EXPORT_TABLE (see docs/GEMINI-SPEND.md)";
  } else {
    try {
      windowStartDay = billedWindowStartDayUtc(now);
      const service = deps.serviceDescription ?? DEFAULT_GEMINI_BILLING_SERVICE;
      const raw = await deps.runQuery!(
        buildBilledQuery(tableId!, service, windowStartDay)
      );
      const inserts = billedRowsFromQuery(raw);
      await deps.replaceGeminiBilledWindow(windowStartDay, inserts);
      rows = inserts.length;
      // A configured sync that matches NOTHING across the whole 95-day
      // window is a broken filter, not a quiet billing month: any live
      // project running Gemini bills something. Reporting ok here is what
      // let a wrong service name ("Generative Language API") render as
      // "$0 billed" on the admin card for 30 days instead of an error.
      if (rows === 0) {
        error =
          `no billed rows matched service "${service}" since ${windowStartDay}: ` +
          "check GEMINI_BILLING_SERVICE_DESCRIPTION against the export's " +
          "service.description values (see docs/GEMINI-SPEND.md)";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const status: GeminiBilledSyncStatus = {
    lastSyncAt: now.toISOString(),
    configured,
    // Pre-setup skips are expected, not failures: only a configured sync
    // that errored, or matched nothing at all, reports not-ok.
    ok: configured && error === null,
    rows,
    error: configured ? error : null,
    windowStartDay
  };
  await deps.recordStatus(status);
  return status;
}
