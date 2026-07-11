/**
 * Lead-backlog import: a spreadsheet of backlog leads → one webhook flow
 * event per row.
 *
 * The owner uploads an Excel/CSV sheet on the import-leads page; the client
 * converts .xlsx to CSV text and POSTs it to
 * /api/dashboard/aiflows/lead-import, which parses here (`parseLeadBacklog`)
 * and, per row, either:
 *   - feeds it through `processWebhookFlowEvent` — the SAME path a
 *     Zapier/Make bridge event takes — so every enabled `webhook`-channel
 *     flow trigger-matches the row with zero flow changes, or
 *   - when the owner picked a TARGET FLOW (`flowId`), enqueues a run of that
 *     one flow directly, no webhook trigger required — the same "just run
 *     this flow with this input" contract as the Run-now button, with the
 *     row's fields as the trigger scope.
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
import { processWebhookFlowEvent, webhookEventKey } from "@/lib/ai-flows/webhook-events";
import { webhookTriggerScope } from "@/lib/ai-flows/trigger-eval";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
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
   *             (same lead re-imported); nothing new was queued.
   * no_match  — no enabled webhook flow's conditions matched the row.
   * skipped   — the row had no non-empty cells to send.
   * error     — this row's enqueue failed (see `errors`); other rows still apply.
   */
  status: "enqueued" | "duplicate" | "no_match" | "skipped" | "error";
  /** When the row's runs become claimable (absent = immediately). */
  earliestClaimAt?: string;
};

export type LeadBacklogImportSummary = {
  totalRows: number;
  enqueued: number;
  duplicates: number;
  unmatched: number;
  skipped: number;
  /** Rows whose enqueue threw (transient DB failure etc.); safe to re-upload. */
  errors: { row: number; message: string }[];
  /** Enabled webhook flows each row was evaluated against. */
  flowsEvaluated: number;
  rows: LeadBacklogRowOutcome[];
};

export type LeadBacklogImportOptions = {
  /** Source label flows can scope with `from_matches`. */
  source?: string;
  /** Seconds between consecutive rows' release; 0 = all immediate. */
  dripIntervalSeconds?: number;
  /**
   * Target flow: enqueue a run of THIS flow per row instead of trigger-
   * matching webhook flows, so no webhook trigger is required. The route
   * validates the flow (exists, enabled, not voice) before calling here.
   */
  flowId?: string;
};

/** The row's explicit id-column key, namespaced by the source label so a
 *  sheet's short ids ("1", "2") can never collide with a live bridge's event
 *  ids. Undefined when the row has no id column. */
function rowExplicitId(row: Record<string, string>, source: string): string | undefined {
  for (const col of ID_COLUMNS) {
    const v = (row[col] ?? "").trim();
    if (v) return `${source}:${v}`;
  }
  return undefined;
}

/**
 * The row's idempotency key: the explicit id column when present, else the
 * payload digest. Digest-keyed rows that repeat within one upload get a
 * stable occurrence suffix (#1, #2, …) so two identical-looking rows still
 * fire independently — while a RE-upload of the same sheet regenerates the
 * same suffixes in the same order and stays fully deduped. Rows sharing an
 * EXPLICIT id are intentionally treated as the same lead (no suffix).
 */
function rowEventId(
  row: Record<string, string>,
  data: Record<string, unknown>,
  source: string,
  seen: Map<string, number>
): string {
  const explicit = rowExplicitId(row, source);
  const key = explicit ?? webhookEventKey({ source, data });
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  if (explicit) return explicit;
  return n === 0 ? key : `${key}#${n}`;
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
    errors: [],
    flowsEvaluated: 0,
    rows: []
  };

  // Occurrence counts for digest-keyed rows (see rowEventId).
  const seenKeys = new Map<string, number>();
  // Drip slot: advances only when a row actually ENQUEUES, so skipped,
  // unmatched, duplicate, and failed rows never leave holes in the release
  // schedule (a re-imported sheet's few new leads start immediately, not
  // hours out).
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

    // Rows apply independently — a transient failure on one row is reported
    // and the rest still land, matching the contacts CSV import's semantics.
    const eventId = rowEventId(rows[i], data, source, seenKeys);
    let result;
    try {
      if (options.flowId) {
        // Targeted mode: enqueue the chosen flow directly. Same scope shape
        // and dedupe key as the webhook path, so switching modes (or later
        // adding a webhook trigger) never re-fires an already-imported lead
        // into the same flow.
        const run = await enqueueAiFlowRun(
          {
            businessId,
            flowId: options.flowId,
            trigger: webhookTriggerScope({ source, data, eventId }),
            dedupeKey: `webhook:${eventId}`,
            ...(earliestClaimAt ? { earliestClaimAt } : {})
          },
          db
        );
        result = { enqueued: run ? 1 : 0, flowsEvaluated: 1, flowsMatched: 1 };
      } else {
        result = await processWebhookFlowEvent(
          businessId,
          { source, data, eventId },
          db,
          earliestClaimAt ? { earliestClaimAt } : undefined
        );
      }
    } catch (e) {
      summary.errors.push({
        row: fileRow,
        message: e instanceof Error ? e.message : "Unexpected error"
      });
      summary.rows.push({ row: fileRow, status: "error" });
      continue;
    }
    summary.flowsEvaluated = result.flowsEvaluated;

    let status: LeadBacklogRowOutcome["status"];
    if (result.enqueued > 0) {
      status = "enqueued";
      summary.enqueued += 1;
      slot += 1;
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
      ...(status === "enqueued" && earliestClaimAt ? { earliestClaimAt } : {})
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
        ...(options.flowId ? { target_flow_id: options.flowId } : {}),
        drip_interval_seconds: intervalS,
        total_rows: summary.totalRows,
        enqueued: summary.enqueued,
        duplicates: summary.duplicates,
        unmatched: summary.unmatched,
        skipped: summary.skipped,
        errored: summary.errors.length,
        flows_evaluated: summary.flowsEvaluated
      }
    },
    db
  );

  return summary;
}
