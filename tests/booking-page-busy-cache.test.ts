import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import {
  BUSY_CACHE_MAX_AGE_MS,
  readBusyCache,
  saveBusyCache
} from "@/lib/booking-page/busy-cache";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockClientFactory = vi.mocked(createSupabaseServiceClient);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveBusyCache", () => {
  function upsertDb(error: { message: string } | null = null) {
    const calls: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
    const upsert = vi.fn((row: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push([row, opts]);
      return Promise.resolve({ error });
    });
    return { client: { from: vi.fn(() => ({ upsert })) } as never, calls };
  }

  it("upserts the snapshot as ISO spans keyed by business", async () => {
    // Through the default service client (the production path); the explicit
    // client parameter is exercised by the error test below.
    const { client, calls } = upsertDb();
    mockClientFactory.mockResolvedValueOnce(client);
    await saveBusyCache(
      BIZ,
      new Date("2026-07-27T00:00:00Z"),
      new Date("2026-08-10T00:00:00Z"),
      [{ start: new Date("2026-07-27T17:00:00Z"), end: new Date("2026-07-27T18:00:00Z") }]
    );
    const [row, opts] = calls[0];
    expect(row).toMatchObject({
      business_id: BIZ,
      busy: [{ start: "2026-07-27T17:00:00.000Z", end: "2026-07-27T18:00:00.000Z" }],
      window_start: "2026-07-27T00:00:00.000Z",
      window_end: "2026-08-10T00:00:00.000Z"
    });
    expect(opts).toEqual({ onConflict: "business_id" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never throws: write errors and non-Error throws are warn-logged", async () => {
    const { client } = upsertDb({ message: "denied" });
    await saveBusyCache(BIZ, new Date(), new Date(), [], client);
    expect(logger.warn).toHaveBeenCalledWith(
      "busy-cache: save failed (cache skipped)",
      expect.objectContaining({ error: "denied" })
    );

    mockClientFactory.mockRejectedValueOnce("factory boom" as never);
    await saveBusyCache(BIZ, new Date(), new Date(), []);
    expect(logger.warn).toHaveBeenCalledWith(
      "busy-cache: save failed (cache skipped)",
      expect.objectContaining({ error: "factory boom" })
    );
  });
});

describe("readBusyCache", () => {
  function readDb(result: { data: unknown; error: { message: string } | null }) {
    return {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(result)
    } as never;
  }

  it("returns fresh spans as Date blocks, skipping malformed entries", async () => {
    const db = readDb({
      data: {
        fetched_at: new Date().toISOString(),
        busy: [
          { start: "2026-07-27T17:00:00Z", end: "2026-07-27T18:00:00Z" },
          { start: "not-a-date", end: "2026-07-27T19:00:00Z" },
          { start: "2026-07-27T19:00:00Z", end: "not-a-date" },
          "garbage"
        ]
      },
      error: null
    });
    expect(await readBusyCache(BIZ, BUSY_CACHE_MAX_AGE_MS, db)).toEqual([
      { start: new Date("2026-07-27T17:00:00Z"), end: new Date("2026-07-27T18:00:00Z") }
    ]);
  });

  it("misses on no row, stale snapshots, unparseable timestamps, and non-array spans", async () => {
    expect(
      await readBusyCache(BIZ, BUSY_CACHE_MAX_AGE_MS, readDb({ data: null, error: null }))
    ).toBeNull();

    const stale = new Date(Date.now() - BUSY_CACHE_MAX_AGE_MS - 60_000).toISOString();
    expect(
      await readBusyCache(
        BIZ,
        BUSY_CACHE_MAX_AGE_MS,
        readDb({ data: { fetched_at: stale, busy: [] }, error: null })
      )
    ).toBeNull();

    expect(
      await readBusyCache(
        BIZ,
        BUSY_CACHE_MAX_AGE_MS,
        readDb({ data: { fetched_at: "whenever", busy: [] }, error: null })
      )
    ).toBeNull();

    expect(
      await readBusyCache(
        BIZ,
        BUSY_CACHE_MAX_AGE_MS,
        readDb({ data: { fetched_at: new Date().toISOString(), busy: "nope" }, error: null })
      )
    ).toBeNull();
  });

  it("misses (warn-logged) on read errors and falls back to the service client", async () => {
    expect(
      await readBusyCache(
        BIZ,
        BUSY_CACHE_MAX_AGE_MS,
        readDb({ data: null, error: { message: "rls" } })
      )
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "busy-cache: read failed (treated as miss)",
      expect.objectContaining({ error: "rls" })
    );

    mockClientFactory.mockRejectedValueOnce("read factory boom" as never);
    expect(await readBusyCache(BIZ)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "busy-cache: read failed (treated as miss)",
      expect.objectContaining({ error: "read factory boom" })
    );

    const db = readDb({
      data: { fetched_at: new Date().toISOString(), busy: [] },
      error: null
    });
    mockClientFactory.mockResolvedValue(db as never);
    expect(await readBusyCache(BIZ)).toEqual([]);
    expect(mockClientFactory).toHaveBeenCalled();
  });
});
