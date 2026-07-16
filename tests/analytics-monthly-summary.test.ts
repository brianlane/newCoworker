import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { getMonthlySummary, monthStart } from "@/lib/analytics/monthly-summary";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-16T12:00:00Z");

type TableResult = { data?: unknown; count?: number | null; error: { message: string } | null };

/**
 * Table-keyed scripted mock. Call order is deterministic:
 * snapshots(current), contacts(current), snapshots(previous),
 * contacts(previous) — each table pops its own queue.
 */
function makeDb(queues: Record<string, TableResult[]>) {
  const calls: Record<string, Array<Array<{ name: string; args: unknown[] }>>> = {};
  const from = vi.fn((table: string) => {
    const log: Array<{ name: string; args: unknown[] }> = [];
    (calls[table] ??= []).push(log);
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt"]) {
      chain[m] = vi.fn((...args: unknown[]) => {
        log.push({ name: m, args });
        return chain;
      });
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const queue = queues[table] ?? [];
      const result = queue.shift() ?? { data: [], count: 0, error: null };
      return Promise.resolve(result).then(resolve);
    };
    return chain;
  });
  return { db: { from } as never, calls };
}

const snapshotRow = (calls: number, sms: number, minutes: number, missed: number) => ({
  calls,
  sms_sent: sms,
  voice_minutes: minutes,
  missed_calls: missed
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("monthStart", () => {
  it("resolves month boundaries incl. year wrap", () => {
    expect(monthStart(NOW).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(monthStart(NOW, 1).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-01-05T00:00:00Z"), -1).toISOString()).toBe(
      "2025-12-01T00:00:00.000Z"
    );
    expect(monthStart(new Date("2026-12-05T00:00:00Z"), 1).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
  });
});

describe("getMonthlySummary", () => {
  it("sums each calendar month's snapshots and counts new contacts", async () => {
    const { db, calls } = makeDb({
      analytics_daily_snapshots: [
        { data: [snapshotRow(3, 10, 12, 1), snapshotRow(2, 5, 8, 0)], error: null },
        { data: [snapshotRow(30, 100, 120, 4)], error: null }
      ],
      contacts: [
        { count: 7, error: null },
        { count: 21, error: null }
      ]
    });
    const summary = await getMonthlySummary(BIZ, { client: db, now: NOW });
    expect(summary.current).toEqual({
      month: "2026-07",
      calls: 5,
      texts: 15,
      voiceMinutes: 20,
      missedCalls: 1,
      newContacts: 7,
      coveredDays: 2
    });
    expect(summary.previous).toEqual({
      month: "2026-06",
      calls: 30,
      texts: 100,
      voiceMinutes: 120,
      missedCalls: 4,
      newContacts: 21,
      coveredDays: 1
    });
    // Window args: current month [Jul 1, Aug 1), previous [Jun 1, Jul 1).
    const snapshotWindows = calls.analytics_daily_snapshots.map((log) => [
      log.find((c) => c.name === "gte")?.args,
      log.find((c) => c.name === "lt")?.args
    ]);
    expect(snapshotWindows[0]).toEqual([
      ["snapshot_date", "2026-07-01"],
      ["snapshot_date", "2026-08-01"]
    ]);
    expect(snapshotWindows[1]).toEqual([
      ["snapshot_date", "2026-06-01"],
      ["snapshot_date", "2026-07-01"]
    ]);
  });

  it("treats null data / null counts as zeros (default client)", async () => {
    const { db } = makeDb({
      analytics_daily_snapshots: [
        { data: null, error: null },
        { data: null, error: null }
      ],
      contacts: [
        { count: null, error: null },
        { count: null, error: null }
      ]
    });
    defaultClientSpy.mockReturnValue(db);
    const summary = await getMonthlySummary(BIZ);
    expect(summary.current.calls).toBe(0);
    expect(summary.current.newContacts).toBe(0);
    expect(summary.current.coveredDays).toBe(0);
  });

  it("throws on snapshot and contact-count errors", async () => {
    const snapErr = makeDb({
      analytics_daily_snapshots: [{ data: null, error: { message: "snap boom" } }],
      contacts: [{ count: 0, error: null }]
    });
    await expect(getMonthlySummary(BIZ, { client: snapErr.db, now: NOW })).rejects.toThrow(
      /snap boom/
    );

    const contactErr = makeDb({
      analytics_daily_snapshots: [
        { data: [], error: null },
        { data: [], error: null }
      ],
      contacts: [{ count: null, error: { message: "contacts boom" } }]
    });
    await expect(getMonthlySummary(BIZ, { client: contactErr.db, now: NOW })).rejects.toThrow(
      /contacts boom/
    );
  });
});
