import { describe, expect, it, vi } from "vitest";

import {
  MAX_CONSECUTIVE_FAILURES,
  dispatchRows,
  runWebhookDispatchTick,
  type DispatchSubscription,
  type SupabaseLike
} from "../supabase/functions/_shared/webhook_dispatch";
import type { WebhookSourceRow } from "../supabase/functions/_shared/webhook_events";

const SUB: DispatchSubscription = {
  id: "hook-1",
  business_id: "biz-1",
  event: "sms.inbound",
  target_url: "https://hooks.zapier.com/abc",
  last_cursor: "2026-07-01T00:00:00Z",
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
  it("delivers rows in order and advances the cursor to the last delivered", async () => {
    const fetchImpl = fetchReturning(200, 200);
    const result = await dispatchRows(
      SUB,
      [row("a", "2026-07-01T00:01:00Z"), row("b", "2026-07-01T00:02:00Z")],
      fetchImpl
    );
    expect(result).toEqual({
      delivered: 2,
      newCursor: "2026-07-01T00:02:00Z",
      gone: false,
      failed: false
    });
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(call[0]).toBe(SUB.target_url);
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.event).toBe("sms.inbound");
    expect(body.data.text).toBe("msg a");
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
      fetchImpl
    );
    expect(result.delivered).toBe(1);
    expect(result.newCursor).toBe("2026-07-01T00:01:00Z");
    expect(result.failed).toBe(true);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("treats 410 Gone as unsubscribe, keeping the cursor at delivered rows", async () => {
    const fetchImpl = fetchReturning(200, 410);
    const result = await dispatchRows(
      SUB,
      [row("a", "2026-07-01T00:01:00Z"), row("b", "2026-07-01T00:02:00Z")],
      fetchImpl
    );
    expect(result).toEqual({
      delivered: 1,
      newCursor: "2026-07-01T00:01:00Z",
      gone: true,
      failed: false
    });
  });

  it("treats a thrown fetch (network error) as a failed tick", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await dispatchRows(SUB, [row("a", "2026-07-01T00:01:00Z")], fetchImpl as never);
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
 * Structural fake matching SupabaseLike: records update patches so tests can
 * assert on cursor/failure bookkeeping.
 */
function makeTickDb(opts: TickDbOptions) {
  const updates: Record<string, unknown>[] = [];
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
      // Source table query chain.
      const result = Promise.resolve({
        data: opts.rows === undefined ? [] : opts.rows,
        error: opts.rowsError ?? null
      });
      const limited = Object.assign(
        {
          filter: vi.fn(() => result)
        },
        { then: result.then.bind(result) }
      );
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            gt: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(() => limited)
              }))
            }))
          }))
        }))
      };
    })
  };
  return { db: db as unknown as SupabaseLike, updates };
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

  it("delivers rows, advances the cursor, and resets the failure counter", async () => {
    const { db, updates } = makeTickDb({
      subs: [{ ...SUB, consecutive_failures: 5 }],
      rows: [row("a", "2026-07-01T00:01:00Z")]
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(200));
    expect(summary.delivered).toBe(1);
    expect(updates).toEqual([
      { last_cursor: "2026-07-01T00:01:00Z", consecutive_failures: 0 }
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

  it("routes filtered events (call.completed) through the .filter branch", async () => {
    const transcriptRow: WebhookSourceRow = {
      id: "call-1",
      created_at: "2026-07-01T00:06:00Z",
      business_id: "biz-1",
      caller_e164: "+16025551234",
      direction: "inbound",
      status: "completed",
      started_at: "2026-07-01T00:04:00Z",
      ended_at: "2026-07-01T00:05:50Z",
      summary: "ok",
      sentiment: "positive"
    };
    const { db, updates } = makeTickDb({
      subs: [{ ...SUB, event: "call.completed" }],
      rows: [transcriptRow]
    });
    const summary = await runWebhookDispatchTick(db, fetchReturning(200));
    expect(summary.delivered).toBe(1);
    expect(updates[0]).toEqual({
      last_cursor: "2026-07-01T00:06:00Z",
      consecutive_failures: 0
    });
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
