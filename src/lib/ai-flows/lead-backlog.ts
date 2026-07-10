/**
 * Lead-backlog import: a spreadsheet of backlog leads → one webhook flow
 * event per row.
 *
 * The owner uploads an Excel/CSV sheet on the AiFlows page; the client
 * converts .xlsx to CSV text and POSTs it to
 * /api/dashboard/aiflows/lead-import, which parses here (`parseLeadBacklog`)
 * and feeds each row through `processWebhookFlowEvent` — the SAME path a
 * Zapier/Make bridge event takes — so every enabled `webhook`-channel flow
 * trigger-matches the row with zero flow changes.
 *
 * Drip pacing: row N's runs carry `earliest_claim_at = now + N * interval`,
 * which the worker's claim RPC honors (the quiet-hours deferral mechanism),
 * so a 200-lead backlog releases over hours instead of blasting the tenant's
 * SMS/email budgets in one sweep.
 *
 * Idempotent per row: the dedupe key is the row's explicit id column
 * (event_id / lead_id / id, namespaced by the source label) or the payload
 * digest, so re-uploading the same sheet never double-enqueues.
 *
 * Service-role only. Owner authorization is the API route's job — same trust
 * model as src/lib/csv/contacts.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { parseCsv } from "@/lib/csv/csv";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { recordSystemLog } from "@/lib/db/system-logs";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Each row can fan out SMS/email, so the cap is far below the CSV import's. */
export const MAX_BACKLOG_ROWS = 500;

export const DEFAULT_DRIP_INTERVAL_SECONDS = 60;
/** 1 hour between rows is already a ~3-week horizon at the row cap. */
export const MAX_DRIP_INTERVAL_SECONDS = 3600;

export const DEFAULT_BACKLOG_SOURCE = "backlog_import";

/**
 * Columns treated as the row's caller idempotency key, in precedence order.
 * (parseCsv normalizes headers to lowercase snake-ish keys.)
 */
const ID_COLUMNS = ["event_id", "lead_id", "id"] as const;

export type LeadBacklogParseResult =
  | { ok: true; headers: string[]; rows: Record<string, string>[] }
  | { ok: false; error: string };

/** Parse + bound the uploaded sheet (CSV text; .xlsx is converted client-side). */
export function parseLeadBacklog(csvText: string): LeadBacklogParseResult {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return parsed;
  if (parsed.rows.length === 0) {
    return { ok: false, error: "The sheet has a header but no lead rows." };
  }
  if (parsed.rows.length > MAX_BACKLOG_ROWS) {
    return {
      ok: false,
      error: `Too many rows (${parsed.rows.length}); the limit is ${MAX_BACKLOG_ROWS} per upload.`
    };
  }
  return { ok: true, headers: parsed.headers, rows: parsed.rows };
}

export type LeadBacklogRowOutcome = {
  /** 1-based file row (row 1 is the header). */
  row: number;
  /**
   * enqueued  — at least one flow run was queued for this row.
   * duplicate — a flow matched but the row was already enqueued earlier
   *             (same sheet re-uploaded); nothing new was queued.
   * no_match  — no enabled webhook flow's conditions matched the row.
   * skipped   — the row had no non-empty cells to send.
   */
  status: "enqueued" | "duplicate" | "no_match" | "skipped";
  /** When the row's runs become claimable (absent = immediately). */
  earliestClaimAt?: string;
};

export type LeadBacklogImportSummary = {
  totalRows: number;
  enqueued: number;
  duplicates: number;
  unmatched: number;
  skipped: number;
  /** Enabled webhook flows each row was evaluated against. */
  flowsEvaluated: number;
  rows: LeadBacklogRowOutcome[];
};

export type LeadBacklogImportOptions = {
  /** Source label flows can scope with `from_matches`. */
  source?: string;
  /** Seconds between consecutive rows' release; 0 = all immediate. */
  dripIntervalSeconds?: number;
};

/** The row's caller idempotency key: explicit id column, else undefined
 *  (processWebhookFlowEvent then digests the payload). Namespaced by the
 *  source label so a sheet's short ids ("1", "2") can never collide with a
 *  live bridge's event ids. */
function rowEventId(row: Record<string, string>, source: string): string | undefined {
  for (const col of ID_COLUMNS) {
    const v = (row[col] ?? "").trim();
    if (v) return `${source}:${v}`;
  }
  return undefined;
}

function clampDripInterval(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return DEFAULT_DRIP_INTERVAL_SECONDS;
  }
  return Math.min(MAX_DRIP_INTERVAL_SECONDS, Math.max(0, Math.floor(seconds)));
}

/**
 * Feed each sheet row through the webhook flow-event path, staggering release
 * times. Rows apply independently (a bad row never blocks the rest — matching
 * the CSV contacts import's row-by-row semantics).
 */
export async function importLeadBacklog(
  businessId: string,
  rows: Record<string, string>[],
  options: LeadBacklogImportOptions = {},
  client?: SupabaseClient
): Promise<LeadBacklogImportSummary> {
  const db = client ?? (await createSupabaseServiceClient());
  const source = (options.source ?? "").trim().slice(0, 120) || DEFAULT_BACKLOG_SOURCE;
  const intervalS = clampDripInterval(options.dripIntervalSeconds);
  const baseMs = Date.now();

  const summary: LeadBacklogImportSummary = {
    totalRows: rows.length,
    enqueued: 0,
    duplicates: 0,
    unmatched: 0,
    skipped: 0,
    flowsEvaluated: 0,
    rows: []
  };

  // Drip slot: advances only for rows actually sent, so skipped rows don't
  // leave holes in the release schedule.
  let slot = 0;
  for (let i = 0; i < rows.length; i++) {
    // 1-based file row: +1 for the header line, +1 for 0-index.
    const fileRow = i + 2;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rows[i])) {
      if (v !== "") data[k] = v;
    }
    if (Object.keys(data).length === 0) {
      summary.skipped += 1;
      summary.rows.push({ row: fileRow, status: "skipped" });
      continue;
    }

    const earliestClaimAt =
      slot > 0 && intervalS > 0
        ? new Date(baseMs + slot * intervalS * 1000).toISOString()
        : undefined;
    slot += 1;

    const result = await processWebhookFlowEvent(
      businessId,
      { source, data, eventId: rowEventId(rows[i], source) },
      db,
      earliestClaimAt ? { earliestClaimAt } : undefined
    );
    summary.flowsEvaluated = result.flowsEvaluated;

    let status: LeadBacklogRowOutcome["status"];
    if (result.enqueued > 0) {
      status = "enqueued";
      summary.enqueued += 1;
    } else if (result.flowsMatched > 0) {
      status = "duplicate";
      summary.duplicates += 1;
    } else {
      status = "no_match";
      summary.unmatched += 1;
    }
    summary.rows.push({
      row: fileRow,
      status,
      ...(earliestClaimAt ? { earliestClaimAt } : {})
    });
  }

  await recordSystemLog(
    {
      businessId,
      source: "aiflow",
      level: "info",
      event: "lead_backlog_import",
      message: `Lead backlog import: ${summary.enqueued}/${summary.totalRows} rows enqueued`,
      payload: {
        source_label: source,
        drip_interval_seconds: intervalS,
        total_rows: summary.totalRows,
        enqueued: summary.enqueued,
        duplicates: summary.duplicates,
        unmatched: summary.unmatched,
        skipped: summary.skipped,
        flows_evaluated: summary.flowsEvaluated
      }
    },
    db
  );

  return summary;
}
