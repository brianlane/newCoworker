/**
 * Pure delivery engine for the webhook-dispatcher Edge cron. Given a
 * subscription, the undelivered source rows (already fetched, ascending by
 * cursor column then id), and a fetch impl, POST each payload to the target
 * and report how far the cursor may advance.
 *
 * Cursor model: a (timestamp, id) TUPLE per subscription. Timestamp alone
 * would drop rows — two events sharing a created_at would leave the second
 * forever behind a `>` cursor once the first advances it (Bugbot: "Duplicate
 * timestamp skips events"). The tick queries
 *   (cursorCol = ts AND id > cursorId) OR cursorCol > ts
 * ordered by (cursorCol, id), which walks the tuple order exactly. Postgres
 * compares uuids bytewise, matching PostgREST's `order=id.asc`.
 *
 * Semantics (Zapier REST-hook conventions):
 *   * Deliveries are in-order; the FIRST failure stops the batch so the
 *     cursor never skips a row. Later rows are retried next tick.
 *   * HTTP 410 Gone from the target means "unsubscribe": Zapier answers 410
 *     when a Zap is turned off, so we deactivate rather than retry forever.
 *   * `consecutiveFailures` counts whole failed ticks; the caller
 *     deactivates a subscription after MAX_CONSECUTIVE_FAILURES so a dead
 *     endpoint doesn't burn cron budget indefinitely.
 */

import {
  buildWebhookPayload,
  WEBHOOK_EVENT_SOURCES,
  type WebhookEventType,
  type WebhookSourceRow
} from "./webhook_events.ts";

/** ~2 hours of failed minute-ticks before a dead endpoint is disabled. */
export const MAX_CONSECUTIVE_FAILURES = 120;

/** Per-tick row cap so one chatty tenant can't starve the batch. */
export const MAX_ROWS_PER_TICK = 25;

/** Initial last_cursor_id — sorts before every real uuid. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type DispatchSubscription = {
  id: string;
  business_id: string;
  event: WebhookEventType;
  target_url: string;
  last_cursor: string;
  last_cursor_id: string;
  consecutive_failures: number;
};

export type CursorTuple = { ts: string; id: string };

export type DispatchResult = {
  delivered: number;
  /** New cursor tuple (last delivered row); null → no advance. */
  newCursor: CursorTuple | null;
  /** True when the target answered 410 Gone → deactivate the subscription. */
  gone: boolean;
  /** True when the tick had at least one delivery failure (non-410). */
  failed: boolean;
};

export async function dispatchRows(
  subscription: DispatchSubscription,
  rows: WebhookSourceRow[],
  cursorColumn: string,
  fetchImpl: typeof fetch
): Promise<DispatchResult> {
  let delivered = 0;
  let newCursor: CursorTuple | null = null;

  for (const row of rows) {
    const payload = buildWebhookPayload(subscription.event, row);
    let res: Response;
    try {
      res = await fetchImpl(subscription.target_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch {
      // Network-level failure: stop the batch, retry from here next tick.
      return { delivered, newCursor, gone: false, failed: true };
    }
    if (res.status === 410) {
      // Consumer said Gone — deactivate. The rows delivered so far still
      // advance the cursor so a later re-activation doesn't replay them.
      return { delivered, newCursor, gone: true, failed: false };
    }
    if (!res.ok) {
      return { delivered, newCursor, gone: false, failed: true };
    }
    delivered += 1;
    newCursor = { ts: String(row[cursorColumn]), id: row.id };
  }

  return { delivered, newCursor, gone: false, failed: false };
}

/**
 * Minimal structural type for the Supabase client so the tick runner is
 * testable with the chain-of-mocks pattern (and portable across the Deno
 * and Node client builds).
 */
type QueryResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

type SourceQuery = QueryResult & {
  filter(col: string, op: string, val: unknown): SourceQuery;
  or(filters: string): SourceQuery;
};

export type SupabaseLike = {
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: unknown): QueryResult & {
        or(filters: string): {
          order(
            col: string,
            opts: { ascending: boolean }
          ): {
            order(
              col: string,
              opts: { ascending: boolean }
            ): {
              limit(n: number): SourceQuery;
            };
          };
        };
      };
    };
    update(patch: Record<string, unknown>): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

export type DispatchTickSummary = {
  subscriptions: number;
  delivered: number;
  deactivated: number;
  failures: number;
};

/**
 * One cron tick: for every ACTIVE subscription, fetch rows past its cursor
 * tuple from the event's source table, deliver them in order, and persist
 * the cursor/failure/active updates. All per-subscription errors are
 * contained — one broken subscription (or source query) never blocks the
 * rest of the batch.
 */
export async function runWebhookDispatchTick(
  db: SupabaseLike,
  fetchImpl: typeof fetch,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  nowMs: number = Date.now()
): Promise<DispatchTickSummary> {
  const summary: DispatchTickSummary = {
    subscriptions: 0,
    delivered: 0,
    deactivated: 0,
    failures: 0
  };

  const { data: subsRaw, error: subsErr } = await db
    .from("webhook_subscriptions")
    .select(
      "id, business_id, event, target_url, last_cursor, last_cursor_id, consecutive_failures"
    )
    .eq("active", true);
  if (subsErr) {
    throw new Error(`webhook dispatch: subscriptions query failed: ${subsErr.message}`);
  }
  const subs = (subsRaw as DispatchSubscription[] | null) ?? [];
  summary.subscriptions = subs.length;

  for (const sub of subs) {
    try {
      const source = WEBHOOK_EVENT_SOURCES[sub.event];
      const col = source.cursorColumn;
      const cursorId = sub.last_cursor_id || NIL_UUID;
      let query = db
        .from(source.table)
        .select(source.select)
        .eq("business_id", sub.business_id)
        // Tuple cursor: strictly-later timestamp, OR same timestamp with a
        // later id — never skips a row that shares the cursor's timestamp.
        .or(`and(${col}.eq.${sub.last_cursor},id.gt.${cursorId}),${col}.gt.${sub.last_cursor}`)
        .order(col, { ascending: true })
        .order("id", { ascending: true })
        .limit(MAX_ROWS_PER_TICK);
      if (source.filter) {
        query = query.filter(source.filter[0], source.filter[1], source.filter[2]);
      }
      if (source.readyOr) {
        query = query.or(source.readyOr(nowMs));
      }
      const { data: rowsRaw, error: rowsErr } = await query;
      if (rowsErr) {
        throw new Error(`source query failed: ${rowsErr.message}`);
      }
      const rows = (rowsRaw as WebhookSourceRow[] | null) ?? [];
      if (rows.length === 0) continue;

      const result = await dispatchRows(sub, rows, col, fetchImpl);
      summary.delivered += result.delivered;

      const patch: Record<string, unknown> = {};
      if (result.newCursor) {
        patch.last_cursor = result.newCursor.ts;
        patch.last_cursor_id = result.newCursor.id;
      }
      if (result.gone) {
        patch.active = false;
        summary.deactivated += 1;
      } else if (result.failed) {
        const failures = sub.consecutive_failures + 1;
        patch.consecutive_failures = failures;
        summary.failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          patch.active = false;
          summary.deactivated += 1;
        }
      } else {
        patch.consecutive_failures = 0;
      }

      const { error: updateErr } = await db
        .from("webhook_subscriptions")
        .update(patch)
        .eq("id", sub.id);
      if (updateErr) {
        throw new Error(`subscription update failed: ${updateErr.message}`);
      }
    } catch (err) {
      summary.failures += 1;
      log("webhook dispatch: subscription tick failed", {
        subscriptionId: sub.id,
        event: sub.event,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return summary;
}
