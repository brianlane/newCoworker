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

/**
 * Dispatch lease duration. A tick claims a subscription by CAS-ing
 * `locked_until` into the future, so an overlapping cron run (slow previous
 * tick, double fire) skips it instead of double-POSTing the same rows. Twice
 * the cron cadence: covers the 50s http timeout with room, while a crashed
 * tick's lease expires after one skipped minute.
 */
export const DISPATCH_LEASE_MS = 120_000;

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
      eq(
        col: string,
        val: unknown
      ): PromiseLike<{ error: { message: string } | null }> & {
        or(filters: string): {
          select(columns: string): QueryResult;
        };
      };
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
    // Tracked across the try so the catch can undo a claimed lease and
    // salvage a delivered-but-unpersisted cursor (see the catch block).
    let leaseClaimed = false;
    let outcome: DispatchResult | null = null;
    try {
      // Claim the dispatch lease (CAS on locked_until). Row-level locking
      // serializes concurrent updates, so exactly one overlapping tick's
      // WHERE still matches — the loser sees zero rows and skips, which is
      // what prevents double-POSTing the same events.
      const { data: claimRaw, error: claimErr } = await db
        .from("webhook_subscriptions")
        .update({ locked_until: new Date(nowMs + DISPATCH_LEASE_MS).toISOString() })
        .eq("id", sub.id)
        .or(`locked_until.is.null,locked_until.lt.${new Date(nowMs).toISOString()}`)
        .select("id");
      if (claimErr) {
        throw new Error(`lease claim failed: ${claimErr.message}`);
      }
      if (((claimRaw as { id: string }[] | null) ?? []).length === 0) {
        continue; // another tick holds the lease
      }
      leaseClaimed = true;

      const source = WEBHOOK_EVENT_SOURCES[sub.event];
      const col = source.cursorColumn;
      const cursorId = sub.last_cursor_id || NIL_UUID;
      // Tuple cursor: strictly-later timestamp, OR same timestamp with a
      // later id — never skips a row that shares the cursor's timestamp.
      // The readiness condition (when present) is NESTED inside each branch
      // rather than added as a second .or(): PostgREST treats `or` as a
      // single query param, so a second .or() would REPLACE the cursor
      // filter instead of ANDing with it (Bugbot: "Second or drops cursor
      // filter"). One combined expression keeps both.
      const ready = source.readyOr ? `,or(${source.readyOr(nowMs)})` : "";
      const cursorOr = ready
        ? `and(${col}.eq.${sub.last_cursor},id.gt.${cursorId}${ready}),and(${col}.gt.${sub.last_cursor}${ready})`
        : `and(${col}.eq.${sub.last_cursor},id.gt.${cursorId}),${col}.gt.${sub.last_cursor}`;
      let query = db
        .from(source.table)
        .select(source.select)
        .eq("business_id", sub.business_id)
        .or(cursorOr)
        .order(col, { ascending: true })
        .order("id", { ascending: true })
        .limit(MAX_ROWS_PER_TICK);
      if (source.filter) {
        query = query.filter(source.filter[0], source.filter[1], source.filter[2]);
      }
      const { data: rowsRaw, error: rowsErr } = await query;
      if (rowsErr) {
        throw new Error(`source query failed: ${rowsErr.message}`);
      }
      const rows = (rowsRaw as WebhookSourceRow[] | null) ?? [];
      if (rows.length === 0) {
        // Nothing to deliver — release the lease immediately so the next
        // tick isn't blocked for the full lease duration.
        await db.from("webhook_subscriptions").update({ locked_until: null }).eq("id", sub.id);
        continue;
      }

      outcome = await dispatchRows(sub, rows, col, fetchImpl);
      summary.delivered += outcome.delivered;

      // Release the lease with the same write that persists the outcome.
      const patch: Record<string, unknown> = { locked_until: null };
      if (outcome.newCursor) {
        patch.last_cursor = outcome.newCursor.ts;
        patch.last_cursor_id = outcome.newCursor.id;
      }
      if (outcome.gone) {
        patch.active = false;
        summary.deactivated += 1;
      } else if (outcome.failed) {
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
      if (leaseClaimed) {
        // Best-effort cleanup: release the lease so the hook isn't dead for
        // the full lease window, and — critically — persist any cursor we
        // DID advance. Rows were already POSTed, so losing the cursor here
        // would replay them to the consumer next tick (Bugbot: "Persist
        // failure duplicates webhooks"). If this write also fails, the
        // lease expires on its own and consumers dedupe on payload `id`.
        try {
          const fallback: Record<string, unknown> = { locked_until: null };
          if (outcome?.newCursor) {
            fallback.last_cursor = outcome.newCursor.ts;
            fallback.last_cursor_id = outcome.newCursor.id;
          }
          const { error: cleanupErr } = await db
            .from("webhook_subscriptions")
            .update(fallback)
            .eq("id", sub.id);
          if (cleanupErr) {
            log("webhook dispatch: lease cleanup failed (lease will expire)", {
              subscriptionId: sub.id,
              error: cleanupErr.message
            });
          }
        } catch (cleanupErr) {
          log("webhook dispatch: lease cleanup failed (lease will expire)", {
            subscriptionId: sub.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          });
        }
      }
    }
  }

  return summary;
}
