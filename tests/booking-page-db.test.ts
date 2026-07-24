import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import {
  BookingPageValidationError,
  countBookingsBetween,
  getBookingPageForBusiness,
  getEnabledBookingPageByToken,
  rotateBookingPageToken,
  upsertBookingPage
} from "@/lib/booking-page/db";
import { BOOKING_PAGE_TOKEN_REGEX } from "@/lib/booking-page/keys";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockClientFactory = vi.mocked(createSupabaseServiceClient);

const ROW = {
  id: "row-1",
  business_id: BIZ,
  token: "ncb_" + "a".repeat(64),
  enabled: true,
  allowed_durations: [15, 30],
  min_notice_minutes: 120,
  max_advance_days: 14,
  buffer_minutes: 0,
  max_daily_bookings: null,
  require_staff_on_shift: false,
  description: null,
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z"
};

type QueryResult = { data?: unknown; error?: { message: string } | null; count?: number | null };

/**
 * Chainable supabase fake: records every method call and resolves the
 * terminal (`maybeSingle` / `single` / awaited builder) with the queued
 * results in order.
 */
function fakeDb(results: QueryResult[]) {
  let call = 0;
  const next = () => results[Math.min(call++, results.length - 1)] ?? { data: null, error: null };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });

  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "lt", "insert", "update", "delete"]) {
      b[method] = vi.fn((...args: unknown[]) => {
        record(method, args);
        return b;
      });
    }
    b.maybeSingle = vi.fn(() => {
      record("maybeSingle", []);
      return Promise.resolve(next());
    });
    b.single = vi.fn(() => {
      record("single", []);
      return Promise.resolve(next());
    });
    // Head-count queries await the builder itself.
    b.then = (resolve: (v: QueryResult) => void) => {
      record("await", []);
      resolve(next());
    };
    return b;
  }

  const from = vi.fn(() => builder());
  return { client: { from } as never, from, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getEnabledBookingPageByToken / getBookingPageForBusiness", () => {
  it("resolves rows and passes through null", async () => {
    const { client } = fakeDb([{ data: ROW, error: null }, { data: null, error: null }]);
    mockClientFactory.mockResolvedValue(client);
    expect(await getEnabledBookingPageByToken(ROW.token)).toEqual(ROW);
    expect(await getEnabledBookingPageByToken(ROW.token)).toBeNull();
  });

  it("throws on read errors", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "boom" } }]);
    mockClientFactory.mockResolvedValue(client);
    await expect(getEnabledBookingPageByToken(ROW.token)).rejects.toThrow(
      "getEnabledBookingPageByToken: boom"
    );
    await expect(getBookingPageForBusiness(BIZ)).rejects.toThrow(
      "getBookingPageForBusiness: boom"
    );
  });

  it("returns the business row when present", async () => {
    const { client } = fakeDb([{ data: ROW, error: null }]);
    expect(await getBookingPageForBusiness(BIZ, client)).toEqual(ROW);
    expect(mockClientFactory).not.toHaveBeenCalled();
  });
});

describe("upsertBookingPage", () => {
  it("creates the row with a minted token when none exists", async () => {
    const { client, calls } = fakeDb([
      { data: null, error: null }, // existence read
      { data: ROW, error: null } // insert
    ]);
    const out = await upsertBookingPage(
      BIZ,
      {
        enabled: true,
        allowedDurations: [15, 60],
        minNoticeMinutes: 60,
        maxAdvanceDays: 21,
        bufferMinutes: 10,
        maxDailyBookings: 5,
        requireStaffOnShift: true,
        description: "  Book a strategy call.  "
      },
      client
    );
    expect(out).toEqual(ROW);
    const insert = calls.find((c) => c.method === "insert");
    const payload = insert?.args[0] as Record<string, unknown>;
    expect(BOOKING_PAGE_TOKEN_REGEX.test(String(payload.token))).toBe(true);
    expect(payload).toMatchObject({
      business_id: BIZ,
      enabled: true,
      allowed_durations: [15, 60],
      min_notice_minutes: 60,
      max_advance_days: 21,
      buffer_minutes: 10,
      max_daily_bookings: 5,
      require_staff_on_shift: true,
      description: "Book a strategy call."
    });
  });

  it("constructs its own client when none is provided", async () => {
    const { client } = fakeDb([
      { data: null, error: null },
      { data: ROW, error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    expect(await upsertBookingPage(BIZ, {})).toEqual(ROW);
    expect(mockClientFactory).toHaveBeenCalledTimes(1);
  });

  it("updates in place without touching the token, blanking description to null", async () => {
    const { client, calls } = fakeDb([
      { data: ROW, error: null }, // existence read
      { data: { ...ROW, enabled: false }, error: null } // update
    ]);
    const out = await upsertBookingPage(
      BIZ,
      { enabled: false, maxDailyBookings: null, description: "   " },
      client
    );
    expect(out.enabled).toBe(false);
    const update = calls.find((c) => c.method === "update");
    const payload = update?.args[0] as Record<string, unknown>;
    expect(payload.token).toBeUndefined();
    expect(payload.max_daily_bookings).toBeNull();
    expect(payload.description).toBeNull();
    expect(typeof payload.updated_at).toBe("string");
  });

  it("rejects every invalid policy value", async () => {
    const { client } = fakeDb([]);
    const bad: Array<Parameters<typeof upsertBookingPage>[1]> = [
      { allowedDurations: [] },
      { allowedDurations: [45] },
      { minNoticeMinutes: -1 },
      { minNoticeMinutes: 10081 },
      { minNoticeMinutes: 1.5 },
      { maxAdvanceDays: 0 },
      { maxAdvanceDays: 61 },
      { bufferMinutes: -5 },
      { bufferMinutes: 121 },
      { maxDailyBookings: 0 },
      { maxDailyBookings: 101 },
      { description: "x".repeat(501) }
    ];
    for (const patch of bad) {
      await expect(upsertBookingPage(BIZ, patch, client)).rejects.toThrow(
        BookingPageValidationError
      );
    }
  });

  it("throws on read, insert, and update errors", async () => {
    const readFail = fakeDb([{ data: null, error: { message: "read boom" } }]);
    await expect(upsertBookingPage(BIZ, {}, readFail.client)).rejects.toThrow(
      "getBookingPageForBusiness: read boom"
    );

    const insertFail = fakeDb([
      { data: null, error: null },
      { data: null, error: { message: "insert boom" } }
    ]);
    await expect(upsertBookingPage(BIZ, {}, insertFail.client)).rejects.toThrow(
      "upsertBookingPage: insert boom"
    );

    const updateFail = fakeDb([
      { data: ROW, error: null },
      { data: null, error: { message: "update boom" } }
    ]);
    await expect(upsertBookingPage(BIZ, {}, updateFail.client)).rejects.toThrow(
      "upsertBookingPage: update boom"
    );
  });
});

describe("rotateBookingPageToken", () => {
  it("stamps a fresh token", async () => {
    const { client, calls } = fakeDb([{ data: ROW, error: null }]);
    mockClientFactory.mockResolvedValue(client);
    const out = await rotateBookingPageToken(BIZ);
    expect(out).toEqual(ROW);
    const update = calls.find((c) => c.method === "update");
    const payload = update?.args[0] as Record<string, unknown>;
    expect(BOOKING_PAGE_TOKEN_REGEX.test(String(payload.token))).toBe(true);
  });

  it("throws on update errors", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "rotate boom" } }]);
    await expect(rotateBookingPageToken(BIZ, client)).rejects.toThrow(
      "rotateBookingPageToken: rotate boom"
    );
  });
});

describe("countBookingsBetween", () => {
  it("returns the exact count, defaulting null to 0", async () => {
    const { client } = fakeDb([
      { count: 7, error: null },
      { count: null, error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    expect(
      await countBookingsBetween(BIZ, "2026-07-24T00:00:00Z", "2026-07-25T00:00:00Z")
    ).toBe(7);
    expect(
      await countBookingsBetween(BIZ, "2026-07-24T00:00:00Z", "2026-07-25T00:00:00Z")
    ).toBe(0);
  });

  it("throws on count errors", async () => {
    const { client } = fakeDb([{ count: null, error: { message: "count boom" } }]);
    await expect(
      countBookingsBetween(BIZ, "2026-07-24T00:00:00Z", "2026-07-25T00:00:00Z", client)
    ).rejects.toThrow("countBookingsBetween: count boom");
  });
});
