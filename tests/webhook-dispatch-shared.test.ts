import { describe, expect, it, vi } from "vitest";

import {
  MAX_CONSECUTIVE_FAILURES,
  NIL_UUID,
  dispatchRows,
  runWebhookDispatchTick,
  type DispatchSubscription,
  type SupabaseLike
} from "../supabase/functions/_shared/webhook_dispatch";
import {
  CALL_SUMMARY_GRACE_MINUTES,
  type WebhookSourceRow
} from "../supabase/functions/_shared/webhook_events";

const SUB: DispatchSubscription = {
  id: "hook-1",
  business_id: "biz-1",
  event: "sms.inbound",
  target_url: "https://hooks.zapier.com/abc",
  last_cursor: "2026-07-01T00:00:00Z",
  last_cursor_id: NIL_UUID,
  consecutive_failures: 0
};

function row(id: string, createdAt: string): WebhookSourceRow {
  return {
    id,
    created_at: createdAt,
    business_id: "biz-1",
    customer_e164: "+16025551234",
    channel: "sms",
    payload: { data: { payload: { text: `msg ${id}` } } }
  };
}

function fetchReturning(...statuses: number[]): typeof fetch {
  const fn = vi.fn();
  for (const status of statuses) {
    fn.mockResolvedValueOnce(new Response(null, { status }));
  }
  return fn as unknown as typeof fetch;
}

describe("dispatchRows", () => {
  it("delivers rows in order and advances the tuple cursor to the last delivered", async () => {
    const fetchImpl = fetchReturning(200, 200);
    const result = await dispatchRows(
      SUB,
      [row("a", "2026-07-01T00:01:00Z"), row("b", "2026-07-01T00:02:00Z")],
      "created_at",
      fetchImpl
    );
    expect(result).toEqual({
      delivered: 2,
      newCursor: { ts: "2026-07-01T00:02:00Z", id: "b" },
      gone: false,
      failed: false
    });
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call[0]).toBe(SUB.target_url);
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.event).toBe("sms.inbound");
    expect(body.data.text).toBe("msg a");
  });

  it("cursors on the configured column (ended_at for call.completed)", async () => {
    const result = await dispatchRows(
      { ...SUB, event: "call.completed" },
      [
        {
          id: "call-1",
          created_at: "2026-07-01T00:00:30Z",
          ended_at: "2026-07-01T00:05:00Z",
          business_id: "biz-1"
        }
      ],
      "ended_at",
      fetchReturning(200)
    );
    expect(result.newCursor).toEqual({ ts: "2026-07-01T00:05:00Z", id: "call-1" });
  });

  it("stops at the first failure so the cursor never skips a row", async () => {
    const fetchImpl = fetchReturning(200, 500, 200);
    const result = await dispatchRows(
      SUB,
      [
        row("a", "2026-07-01T00:01:00Z"),
        row("b", "2026-07-01T00:02:00Z"),
        row("c", "2026-07-01T00:03:00Z")
      ],
      "created_at",
      fetchImpl
    );
    expect(result.delivered).toBe(1);
    expect(result.newCursor).toEqual({ ts: "2026-07-01T00:01:00Z", id: "a" });
    expect(result.failed).toBe(true);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("treats 410 Gone as unsubscribe, keeping the cursor at delivered rows", async () => {
    const fetchImpl = fetchReturning(200, 410);
    const result = await dispatchRows(
      SUB,
      [row("a", "2026-07-01T00:01:00Z"), row("b", "2026-07-01T00:02:00Z")],
      "created_at",
      fetchImpl
    );
    expect(result).toEqual({
      delivered: 1,
      newCursor: { ts: "2026-07-01T00:01:00Z", id: "a" },
      gone: true,
      failed: false
    });
  });

  it("treats a thrown fetch (network error) as a failed tick", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await dispatchRows(
      SUB,
      [row("a", "2026-07-01T00:01:00Z")],
      "created_at",
      fetchImpl as never
    );
    expect(result).toEqual({ delivered: 0, newCursor: null, gone: false, failed: true });
  });
});

type TickDbOptions = {
  subs?: unknown[] | null;
  subsError?: { message: string } | null;
  rows?: unknown[] | null;
  rowsError?: { message: string } | null;
  updateError?: { message: string } | null;
};

/**
 * Structural fake matching SupabaseLike: records update patches and source
 * query calls (or/filter/order args) so tests can assert on cursor
 * bookkeeping and query construction.
 */
function makeTickDb(opts: TickDbOptions) {
  const updates: Record<string, unknown>[] = [];
  const orCalls: string[] = [];
  const filterCalls: unknown[][] = [];
  const orderCalls: unknown[][] = [];

  const db = {
    from: vi.fn((table: string) => {
      if (table === "webhook_subscriptions") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() =>
              Promise.resolve({
                data: opts.subs === undefined ? [] : opts.subs,
                error: opts.subsError ?? null
              })
            )
          })),
          update: vi.fn((patch: Record<string, unknown>) => {
            updates.push(patch);
            return {
              eq: vi.fn(() => Promise.resolve({ error: opts.updateError ?? null }))
            };
          })
        };
      }
      // Source table query: thenable chain supporting or/filter after limit.
      const result = Promise.resolve({
        data: opts.rows === undefined ? [] : opts.rows,
        error: opts.rowsError ?? null
      });
      const sourceQuery: Record<string, unknown> = {
        filter: vi.fn((...args: unknown[]) => {
          filterCalls.push(args);
          return sourceQuery;
        }),
        or: vi.fn((f: string) => {
          orCalls.push(f);
          return sourceQuery;
        }),
        then: result.then.bind(result)
      };
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            or: vi.fn((f: string) => {
              orCalls.push(f);
              return {
                order: vi.fn((...a: unknown[]) => {
                  orderCalls.push(a);
                  return {
                    order: vi.fn((...b: unknown[]) => {
                      orderCalls.push(b);
                      return { limit: vi.fn(() => sourceQuery) };
                    })
                  };
                })
              };
            })
          }))
        }))
      };
    })
  };
  return { db: db as unknown as SupabaseLike, updates, orCalls, filterCalls, orderCalls };
}

describe("runWebhookDispatchTick", () => {
  it("throws when the subscriptions query fails", async () => {
    const { db } = makeTickDb({ subsError: { message: "db down" } });
    await expect(runWebhookDispatchTick(db, fetchReturning(200))).rejects.toThrow(/db down/);
  });

  it("no-ops on zero subscriptions / zero new rows", async () => {
    const empty = makeTickDb({ subs: [] });
    expect(await runWebhookDispatchTick(empty.db, fetchReturning())).toEqual({
      subscriptions: 0,
      delivered: 0,
      deactivated: 0,
      failures: 0
    });

    const noRows = makeTickDb({ subs: [SUB], rows: [] });
    const summary = await runWebhookDispatchTick(noRows.db, fetchReturning());
    expect(summary.subscriptions).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(noRows.updates).toHaveLength(0);
  });

  it("queries with the tuple cursor (same-timestamp id tiebreak) and (cursor, id) ordering", async () => {
    const { db, orCalls, orderCalls } = makeTickDb({
      subs: [{ ...SUB, last_cursor_id: "aaaa1111-0000-4000-8000-000000000001" }],
      rows: []
    });
    await runWebhookDispatchTick(db, fetchReturning());
    expect(orCalls[0]).toBe(
      "and(created_at.eq.2026-07-01T00:00:00Z,id.gt.aaaa1111-0000-4000-8000-000000000001)," +
        "created_at.gt.2026-07-01T00:00:00Z"
    );
    expect(orderCalls[0]).toEqual(["created_at", { ascending: true }]);
    expect(orderCalls[1]).toEqual(["id", { ascending: true }]);
  });

  it("falls back to the nil uuid when last_cursor_id is empty (pre-migration row)", async () => {
    const { db, orCalls } = makeTickDb({
      subs: [{ ...SUB, last_cursor_id: "" }],
      rows: []
    });
    await runWebhookDispatchTick(db, fetchReturning());
    expect(orCalls[0]).toContain(`id.gt.${NIL_UUID}`);
  });

  it("delivers rows, advances the tuple cursor, and resets the failure counter", async () => {
    const { db, updates } = makeTickDb({
      subs: [{ ...SUB, consecutive_failures: 5 }],
      rows: [row("a", "2026-07-01T00:01:00Z")]
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(200));
    expect(summary.delivered).toBe(1);
    expect(updates).toEqual([
      {
        last_cursor: "2026-07-01T00:01:00Z",
        last_cursor_id: "a",
        consecutive_failures: 0
      }
    ]);
  });

  it("deactivates on 410 Gone", async () => {
    const { db, updates } = makeTickDb({
      subs: [SUB],
      rows: [row("a", "2026-07-01T00:01:00Z")]
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(410));
    expect(summary.deactivated).toBe(1);
    expect(updates[0]).toEqual({ active: false });
  });

  it("increments the failure counter without deactivating below the cap", async () => {
    const { db, updates } = makeTickDb({
      subs: [SUB],
      rows: [row("a", "2026-07-01T00:01:00Z")]
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(500));
    expect(summary.failures).toBe(1);
    expect(summary.deactivated).toBe(0);
    expect(updates[0]).toEqual({ consecutive_failures: 1 });
  });

  it("increments the failure counter and deactivates at the cap", async () => {
    const nearCap = makeTickDb({
      subs: [{ ...SUB, consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1 }],
      rows: [row("a", "2026-07-01T00:01:00Z")]
    });
    const summary = await runWebhookDispatchTick(nearCap.db, fetchReturning(500));
    expect(summary.failures).toBe(1);
    expect(summary.deactivated).toBe(1);
    expect(nearCap.updates[0]).toEqual({
      consecutive_failures: MAX_CONSECUTIVE_FAILURES,
      active: false
    });
  });

  it("contains per-subscription errors so one broken source doesn't block the rest", async () => {
    const log = vi.fn();
    const { db } = makeTickDb({
      subs: [SUB, { ...SUB, id: "hook-2" }],
      rowsError: { message: "source table gone" }
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(), log);
    expect(summary.failures).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("counts a failed subscription-row update as a contained failure", async () => {
    const { db } = makeTickDb({
      subs: [SUB],
      rows: [row("a", "2026-07-01T00:01:00Z")],
      updateError: { message: "update lost" }
    });
    // Also exercises the default no-op logger (no third argument).
    const summary = await runWebhookDispatchTick(db, fetchReturning(200));
    expect(summary.delivered).toBe(1);
    expect(summary.failures).toBe(1);
  });

  it("treats null data from both queries as empty result sets", async () => {
    const { db } = makeTickDb({ subs: null, rows: null });
    expect(await runWebhookDispatchTick(db, fetchReturning())).toEqual({
      subscriptions: 0,
      delivered: 0,
      deactivated: 0,
      failures: 0
    });

    const nullRows = makeTickDb({ subs: [SUB], rows: null });
    const summary = await runWebhookDispatchTick(nullRows.db, fetchReturning());
    expect(summary.subscriptions).toBe(1);
    expect(summary.delivered).toBe(0);
  });

  it("call.completed: cursors on ended_at, filters unfinished rows, and gates on summary readiness", async () => {
    const nowMs = Date.parse("2026-07-01T01:00:00Z");
    const transcriptRow: WebhookSourceRow = {
      id: "call-1",
      created_at: "2026-07-01T00:03:00Z",
      business_id: "biz-1",
      caller_e164: "+16025551234",
      direction: "inbound",
      status: "completed",
      started_at: "2026-07-01T00:04:00Z",
      ended_at: "2026-07-01T00:05:50Z",
      summary: "ok",
      sentiment: "positive"
    };
    const { db, updates, orCalls, filterCalls } = makeTickDb({
      subs: [{ ...SUB, event: "call.completed" }],
      rows: [transcriptRow]
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(200), undefined, nowMs);
    expect(summary.delivered).toBe(1);
    // Cursor tuple uses ended_at + id.
    expect(updates[0]).toEqual({
      last_cursor: "2026-07-01T00:05:50Z",
      last_cursor_id: "call-1",
      consecutive_failures: 0
    });
    expect(orCalls[0]).toContain("ended_at.eq.2026-07-01T00:00:00Z");
    expect(filterCalls[0]).toEqual(["ended_at", "not.is", "null"]);
    // Readiness gate: summarized OR grace elapsed.
    const graceCutoff = new Date(
      nowMs - CALL_SUMMARY_GRACE_MINUTES * 60_000
    ).toISOString();
    expect(orCalls[1]).toBe(`summarized_at.not.is.null,ended_at.lt.${graceCutoff}`);
  });

  it("logs a non-Error subscription failure via String(err)", async () => {
    const log = vi.fn();
    const db = {
      from: vi.fn((table: string) => {
        if (table === "webhook_subscriptions") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: [SUB], error: null }))
            }))
          };
        }
        // Non-Error throw from the source query chain.
        return {
          select: vi.fn(() => {
            throw "string blowup";
          })
        };
      })
    } as unknown as SupabaseLike;
    const summary = await runWebhookDispatchTick(db, fetchReturning(), log);
    expect(summary.failures).toBe(1);
    expect(log).toHaveBeenCalledWith(
      "webhook dispatch: subscription tick failed",
      expect.objectContaining({ error: "string blowup" })
    );
  });
});
