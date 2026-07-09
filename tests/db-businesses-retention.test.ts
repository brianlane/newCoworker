import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  MIN_DATA_RETENTION_DAYS,
  listBusinessesWithRetention,
  updateDataRetentionDays
} from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

describe("updateDataRetentionDays", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDb(writeError: { message: string } | null = null) {
    const eq = vi.fn().mockResolvedValue({ error: writeError });
    const update = vi.fn().mockReturnValue({ eq });
    return { db: { from: vi.fn().mockReturnValue({ update }) }, update, eq };
  }

  it("writes a valid window", async () => {
    const { db, update, eq } = mockDb();
    await updateDataRetentionDays("biz-1", 90, db as never);
    expect(update).toHaveBeenCalledWith({ data_retention_days: 90 });
    expect(eq).toHaveBeenCalledWith("id", "biz-1");
  });

  it("null clears the window (keep forever)", async () => {
    const { db, update } = mockDb();
    await updateDataRetentionDays("biz-1", null, db as never);
    expect(update).toHaveBeenCalledWith({ data_retention_days: null });
  });

  it("rejects windows under the floor and non-integers without writing", async () => {
    const { db, update } = mockDb();
    await expect(
      updateDataRetentionDays("biz-1", MIN_DATA_RETENTION_DAYS - 1, db as never)
    ).rejects.toThrow(/integer >= 30/);
    await expect(updateDataRetentionDays("biz-1", 45.5, db as never)).rejects.toThrow(
      /integer >= 30/
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("throws on write error and supports the default client", async () => {
    const { db } = mockDb({ message: "boom" });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(updateDataRetentionDays("biz-1", 30)).rejects.toThrow(
      /updateDataRetentionDays: boom/
    );
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("listBusinessesWithRetention", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDb(result: { data: unknown; error: { message: string } | null }) {
    const not = vi.fn().mockResolvedValue(result);
    const select = vi.fn().mockReturnValue({ not });
    return { db: { from: vi.fn().mockReturnValue({ select }) }, select, not };
  }

  it("returns the configured businesses", async () => {
    const rows = [{ id: "biz-1", data_retention_days: 90 }];
    const { db, select, not } = mockDb({ data: rows, error: null });
    await expect(listBusinessesWithRetention(db as never)).resolves.toEqual(rows);
    expect(select).toHaveBeenCalledWith("id, data_retention_days");
    expect(not).toHaveBeenCalledWith("data_retention_days", "is", null);
  });

  it("coerces a null data payload to an empty list", async () => {
    const { db } = mockDb({ data: null, error: null });
    await expect(listBusinessesWithRetention(db as never)).resolves.toEqual([]);
  });

  it("throws on read error and supports the default client", async () => {
    const { db } = mockDb({ data: null, error: { message: "boom" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listBusinessesWithRetention()).rejects.toThrow(
      /listBusinessesWithRetention: boom/
    );
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
