/**
 * Pure delivery engine for the webhook-dispatcher Edge cron. Given a
 * subscription, the undelivered source rows (already fetched, ascending by
 * created_at), and a fetch impl, POST each payload to the target and report
 * how far the cursor may advance.
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

export type DispatchSubscription = {
  id: string;
  business_id: string;
  event: WebhookEventType;
  target_url: string;
  last_cursor: string;
  consecutive_failures: number;
};

export type DispatchResult = {
  delivered: number;
  /** New cursor value (last delivered row's created_at); null → no advance. */
  newCursor: string | null;
  /** True when the target answered 410 Gone → deactivate the subscription. */
  gone: boolean;
  /** True when the tick had at least one delivery failure (non-410). */
  failed: boolean;
};

export async function dispatchRows(
  subscription: DispatchSubscription,
  rows: WebhookSourceRow[],
  fetchImpl: typeof fetch
): Promise<DispatchResult> {
  let delivered = 0;
  let newCursor: string | null = null;

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
    newCursor = row.created_at;
  }

  return { delivered, newCursor, gone: false, failed: false };
}

/**
 * Minimal structural type for the Supabase client so the tick runner is
 * testable with the chain-of-mocks pattern (and portable across the Deno
 * and Node client builds).
 */
type QueryResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type SupabaseLike = {
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: unknown): QueryResult & {
        gt(col: string, val: unknown): {
          order(
            col: string,
            opts: { ascending: boolean }
          ): {
            limit(n: number): QueryResult & {
              filter(col: string, op: string, val: unknown): QueryResult;
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
 * One cron tick: for every ACTIVE subscription, fetch rows newer than its
 * cursor from the event's source table, deliver them in order, and persist
 * the cursor/failure/active updates. All per-subscription errors are
 * contained — one broken subscription (or source query) never blocks the
 * rest of the batch.
 */
export async function runWebhookDispatchTick(
  db: SupabaseLike,
  fetchImpl: typeof fetch,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {}
): Promise<DispatchTickSummary> {
  const summary: DispatchTickSummary = {
    subscriptions: 0,
    delivered: 0,
    deactivated: 0,
    failures: 0
  };

  const { data: subsRaw, error: subsErr } = await db
    .from("webhook_subscriptions")
    .select("id, business_id, event, target_url, last_cursor, consecutive_failures")
    .eq("active", true);
  if (subsErr) {
    throw new Error(`webhook dispatch: subscriptions query failed: ${subsErr.message}`);
  }
  const subs = (subsRaw as DispatchSubscription[] | null) ?? [];
  summary.subscriptions = subs.length;

  for (const sub of subs) {
    try {
      const source = WEBHOOK_EVENT_SOURCES[sub.event];
      const baseQuery = db
        .from(source.table)
        .select(source.select)
        .eq("business_id", sub.business_id)
        .gt("created_at", sub.last_cursor)
        .order("created_at", { ascending: true })
        .limit(MAX_ROWS_PER_TICK);
      const { data: rowsRaw, error: rowsErr } = source.filter
        ? await baseQuery.filter(source.filter[0], source.filter[1], source.filter[2])
        : await baseQuery;
      if (rowsErr) {
        throw new Error(`source query failed: ${rowsErr.message}`);
      }
      const rows = (rowsRaw as WebhookSourceRow[] | null) ?? [];
      if (rows.length === 0) continue;

      const result = await dispatchRows(sub, rows, fetchImpl);
      summary.delivered += result.delivered;

      const patch: Record<string, unknown> = {};
      if (result.newCursor) patch.last_cursor = result.newCursor;
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
