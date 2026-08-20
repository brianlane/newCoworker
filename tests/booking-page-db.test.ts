import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import {
  BookingPageValidationError,
  countBookingsBetween,
  deleteManagedBooking,
  getBookingByManageToken,
  getBookingPageForBusiness,
  getEnabledBookingPageBySlug,
  getEnabledBookingPageByToken,
  listBookingStartsBetween,
  listUpcomingBookings,
  moveManagedBooking,
  recordPlatformBooking,
  rotateBookingPageToken,
  countUpcomingByAssignee,
  stampAssigneeByClaimId,
  stampAssigneeIfUnset,
  claimOwnerBookingAlert,
  stampAttendeeContact,
  stampManageToken,
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
    for (const method of [
      "select",
      "eq",
      "is",
      "not",
      "gte",
      "lt",
      "order",
      "limit",
      "insert",
      "update",
      "delete"
    ]) {
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
    await expect(getEnabledBookingPageBySlug("new-coworker")).rejects.toThrow(
      "getEnabledBookingPageBySlug: boom"
    );
  });

  it("resolves enabled pages by vanity slug", async () => {
    const { client, calls } = fakeDb([
      { data: ROW, error: null },
      { data: null, error: null }
    ]);
    expect(await getEnabledBookingPageBySlug("new-coworker", client)).toEqual(ROW);
    const eqCalls = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqCalls).toContainEqual(["slug", "new-coworker"]);
    expect(eqCalls).toContainEqual(["enabled", true]);
    expect(await getEnabledBookingPageBySlug("other", client)).toBeNull();
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
      { description: "x".repeat(501) },
      { waitlistOfferTtlMinutes: 14 },
      { waitlistOfferTtlMinutes: 1441 },
      { waitlistOfferTtlMinutes: 60.5 },
      { slug: "ab" },
      { slug: "Not Valid!" },
      { slug: "api" }
    ];
    for (const patch of bad) {
      await expect(upsertBookingPage(BIZ, patch, client)).rejects.toThrow(
        BookingPageValidationError
      );
    }
  });

  it("persists the cancellation-waitlist knobs", async () => {
    const { client, calls } = fakeDb([
      { data: ROW, error: null }, // existence read
      { data: { ...ROW, waitlist_enabled: false }, error: null } // update
    ]);
    await upsertBookingPage(
      BIZ,
      { waitlistEnabled: false, waitlistOfferTtlMinutes: 120 },
      client
    );
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({
      waitlist_enabled: false,
      waitlist_offer_ttl_minutes: 120
    });
  });

  it("normalizes slug writes, clearing on blank", async () => {
    const { client, calls } = fakeDb([
      { data: ROW, error: null }, // existence read
      { data: ROW, error: null } // update
    ]);
    await upsertBookingPage(BIZ, { slug: " New-Coworker " }, client);
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ slug: "new-coworker" });

    const clearing = fakeDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    await upsertBookingPage(BIZ, { slug: "" }, clearing.client);
    const clearUpdate = clearing.calls.find((c) => c.method === "update");
    expect(clearUpdate?.args[0]).toMatchObject({ slug: null });

    // Explicit null clears too (the API's nullable field).
    const nullClear = fakeDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    await upsertBookingPage(BIZ, { slug: null }, nullClear.client);
    const nullUpdate = nullClear.calls.find((c) => c.method === "update");
    expect(nullUpdate?.args[0]).toMatchObject({ slug: null });
  });

  it("maps a slug unique-violation to an owner-facing validation error", async () => {
    const { client } = fakeDb([
      { data: ROW, error: null },
      {
        data: null,
        error: { message: 'duplicate key value violates unique constraint "uq_booking_pages_slug"' }
      }
    ]);
    await expect(upsertBookingPage(BIZ, { slug: "taken-name" }, client)).rejects.toThrow(
      "That custom link is already taken"
    );

    // Any OTHER unique violation stays a generic error, never slug copy.
    const otherUnique = fakeDb([
      { data: null, error: null },
      {
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "uq_booking_pages_business"'
        }
      }
    ]);
    await expect(upsertBookingPage(BIZ, {}, otherUnique.client)).rejects.toThrow(
      "upsertBookingPage: duplicate key"
    );
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

describe("listBookingStartsBetween", () => {
  it("maps ledger rows to Date instants, defaulting an empty payload", async () => {
    const { client } = fakeDb([
      { data: [{ start_at: "2026-07-25T17:00:00Z" }], error: null },
      { data: null, error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    const out = await listBookingStartsBetween(
      BIZ,
      "2026-07-25T00:00:00Z",
      "2026-07-26T00:00:00Z"
    );
    expect(out).toEqual([new Date("2026-07-25T17:00:00Z")]);
    expect(
      await listBookingStartsBetween(BIZ, "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z", client)
    ).toEqual([]);
  });

  it("throws on read errors", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "starts boom" } }]);
    await expect(
      listBookingStartsBetween(BIZ, "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z", client)
    ).rejects.toThrow("listBookingStartsBetween: starts boom");
  });
});

describe("listUpcomingBookings", () => {
  const LEDGER = [
    {
      attendee_key: "phone:+14805550100",
      start_at: "2026-07-25T17:00:00Z",
      event_id: "evt-1",
      zoom_meeting_id: "123"
    }
  ];

  it("lists soonest-first upcoming rows, defaulting an empty payload", async () => {
    const { client, calls } = fakeDb([
      { data: LEDGER, error: null },
      { data: null, error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    expect(await listUpcomingBookings(BIZ)).toEqual(LEDGER);
    const order = calls.find((c) => c.method === "order");
    expect(order?.args).toEqual(["start_at", { ascending: true }]);
    const limit = calls.find((c) => c.method === "limit");
    expect(limit?.args).toEqual([25]);
    expect(await listUpcomingBookings(BIZ, 5, client)).toEqual([]);
  });

  it("throws on read errors", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "list boom" } }]);
    await expect(listUpcomingBookings(BIZ, 25, client)).rejects.toThrow(
      "listUpcomingBookings: list boom"
    );
  });
});

describe("listBookingStartsBetween", () => {
  it("maps ledger rows to Date instants, defaulting an empty payload", async () => {
    const { client } = fakeDb([
      { data: [{ start_at: "2026-07-25T17:00:00Z" }], error: null },
      { data: null, error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    const out = await listBookingStartsBetween(
      BIZ,
      "2026-07-25T00:00:00Z",
      "2026-07-26T00:00:00Z"
    );
    expect(out).toEqual([new Date("2026-07-25T17:00:00Z")]);
    expect(
      await listBookingStartsBetween(BIZ, "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z", client)
    ).toEqual([]);
  });

  it("throws on read errors", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "starts boom" } }]);
    await expect(
      listBookingStartsBetween(BIZ, "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z", client)
    ).rejects.toThrow("listBookingStartsBetween: starts boom");
  });
});

describe("recordPlatformBooking", () => {
  function insertDb(error: { message: string; code?: string } | null = null) {
    const inserts: Array<Record<string, unknown>> = [];
    const insert = vi.fn((row: Record<string, unknown>) => {
      inserts.push(row);
      return Promise.resolve({ error });
    });
    return { client: { from: vi.fn(() => ({ insert })) } as never, inserts };
  }

  it("inserts the confirmed ledger row (the booking record in platform mode)", async () => {
    const { client, inserts } = insertDb();
    const out = await recordPlatformBooking(
      BIZ,
      "phone:+14805550100",
      "2026-07-27T17:00:00.000Z",
      "platform:abc",
      "zm-1",
      client
    );
    expect(out).toEqual({ ok: true });
    expect(inserts[0]).toEqual({
      business_id: BIZ,
      attendee_key: "phone:+14805550100",
      start_at: "2026-07-27T17:00:00.000Z",
      event_id: "platform:abc",
      zoom_meeting_id: "zm-1"
    });
  });

  it("classifies duplicates and other errors, and falls back to the service client", async () => {
    const dup = insertDb({ message: "duplicate key", code: "23505" });
    expect(
      await recordPlatformBooking(BIZ, "k", "2026-07-27T17:00:00Z", "platform:x", null, dup.client)
    ).toEqual({ ok: false, reason: "duplicate" });

    const boom = insertDb({ message: "denied" });
    mockClientFactory.mockResolvedValue(boom.client);
    expect(
      await recordPlatformBooking(BIZ, "k", "2026-07-27T17:00:00Z", "platform:x", null)
    ).toEqual({ ok: false, reason: "error" });
    expect(mockClientFactory).toHaveBeenCalled();
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

describe("manage tokens on the booking ledger", () => {
  const TOKEN = `ncbm_${"b".repeat(64)}`;

  it("stamps a token onto the row a page booking just created, once", async () => {
    const { client, calls } = fakeDb([{ data: [{ id: "row-9" }], error: null }]);
    expect(
      await stampManageToken(BIZ, "phone:+14805550100", "2026-07-27T16:00:00Z", TOKEN, 30, client)
    ).toBe(true);
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      manage_token: TOKEN,
      duration_minutes: 30
    });
    // Only ever a row that has none: a retry must not mint a second token
    // and orphan the first.
    expect(calls.some((c) => c.method === "is" || c.method === "eq")).toBe(true);
  });

  it("reports no stamp when nothing matched (already stamped, or gone)", async () => {
    const { client } = fakeDb([{ data: [], error: null }]);
    expect(
      await stampManageToken(BIZ, "phone:+1", "2026-07-27T16:00:00Z", TOKEN, 30, client)
    ).toBe(false);

    const { client: nullData } = fakeDb([{ data: null, error: null }]);
    expect(
      await stampManageToken(BIZ, "phone:+1", "2026-07-27T16:00:00Z", TOKEN, 30, nullData)
    ).toBe(false);
  });

  it("resolves a booking by its manage token, and passes null through", async () => {
    const row = {
      id: "row-9",
      business_id: BIZ,
      attendee_key: "phone:+14805550100",
      start_at: "2026-07-27T16:00:00Z",
      event_id: "evt-1",
      zoom_meeting_id: null,
      duration_minutes: 30
    };
    const { client } = fakeDb([
      { data: row, error: null },
      { data: null, error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    expect(await getBookingByManageToken(TOKEN)).toEqual(row);
    expect(await getBookingByManageToken(TOKEN)).toBeNull();
  });

  it("moves and deletes a platform booking by row id", async () => {
    const { client, calls } = fakeDb([{ error: null }]);
    await moveManagedBooking("row-9", "2026-07-28T16:00:00Z", client);
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      start_at: "2026-07-28T16:00:00Z",
      // The old time's reminder stamps go with it, or the new time is
      // never reminded.
      reminders_sent: {}
    });

    const { client: delClient, calls: delCalls } = fakeDb([{ error: null }]);
    await deleteManagedBooking("row-9", delClient);
    expect(delCalls.some((c) => c.method === "delete")).toBe(true);
  });

  it("throws on write failures rather than silently losing the change", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(
      stampManageToken(BIZ, "phone:+1", "2026-07-27T16:00:00Z", TOKEN, 30, client)
    ).rejects.toThrow("stampManageToken: denied");

    const { client: readFail } = fakeDb([{ data: null, error: { message: "rls" } }]);
    await expect(getBookingByManageToken(TOKEN, readFail)).rejects.toThrow(
      "getBookingByManageToken: rls"
    );

    const { client: moveFail } = fakeDb([{ error: { message: "locked" } }]);
    await expect(moveManagedBooking("row-9", "2026-07-28T16:00:00Z", moveFail)).rejects.toThrow(
      "moveManagedBooking: locked"
    );

    const { client: delFail } = fakeDb([{ error: { message: "locked" } }]);
    await expect(deleteManagedBooking("row-9", delFail)).rejects.toThrow(
      "deleteManagedBooking: locked"
    );
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await moveManagedBooking("row-9", "2026-07-28T16:00:00Z");
    await deleteManagedBooking("row-9");
    await stampManageToken(BIZ, "phone:+1", "2026-07-27T16:00:00Z", TOKEN, 30);
    expect(mockClientFactory).toHaveBeenCalled();
  });

  it("carries the manage token on a platform booking INSERT", async () => {
    const { client, calls } = fakeDb([{ error: null }]);
    await recordPlatformBooking(
      BIZ,
      "phone:+14805550100",
      "2026-07-27T16:00:00Z",
      "platform:abc",
      null,
      client,
      { token: TOKEN, durationMinutes: 60 }
    );
    expect(calls.find((c) => c.method === "insert")?.args[0]).toMatchObject({
      manage_token: TOKEN,
      duration_minutes: 60
    });
  });
});

describe("reminder settings and attendee contact", () => {
  it("accepts 0 (channel off) through 168 hours, and rejects the rest", async () => {
    const { client } = fakeDb([{ data: ROW, error: null }, { data: ROW, error: null }]);
    await expect(
      upsertBookingPage(BIZ, { reminderEmailHours: 0, reminderSmsHours: 168 }, client)
    ).resolves.toBeTruthy();

    for (const patch of [
      { reminderEmailHours: -1 },
      { reminderEmailHours: 169 },
      { reminderEmailHours: 1.5 },
      { reminderSmsHours: -1 }
    ]) {
      await expect(upsertBookingPage(BIZ, patch, client)).rejects.toThrow(
        /lead time must be 0 to 168 hours/
      );
    }
  });

  it("writes the reminder knobs onto the page", async () => {
    const { client, calls } = fakeDb([{ data: ROW, error: null }, { data: ROW, error: null }]);
    await upsertBookingPage(
      BIZ,
      {
        sendConfirmationEmail: false,
        remindersEnabled: false,
        reminderEmailHours: 48,
        reminderSmsHours: 4
      },
      client
    );
    const update = calls.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({
      send_confirmation_email: false,
      reminders_enabled: false,
      reminder_email_hours: 48,
      reminder_sms_hours: 4
    });
  });

  it("claims the owner alert once, and reports who holds the booking", async () => {
    const { client, calls } = fakeDb([
      { data: [{ id: "row-1", assignee_member_id: "m-ana" }], error: null }
    ]);
    expect(
      await claimOwnerBookingAlert(BIZ, "phone:+14805550100", "2026-07-27T16:00:00Z", client)
    ).toEqual({ claimed: true, assigneeMemberId: "m-ana" });
    // Conditional on nobody having claimed it, which is what makes a
    // resubmit able to close the "booking landed, owner never told" gap
    // without ever being able to alert twice.
    expect(calls.filter((c) => c.method === "is").map((c) => c.args)).toContainEqual([
      "owner_alerted_at",
      null
    ]);
    expect(Object.keys(calls.find((c) => c.method === "update")?.args[0] as object)).toEqual([
      "owner_alerted_at"
    ]);

    // Already claimed: the owner has been told, so this caller stays quiet.
    const { client: taken } = fakeDb([{ data: [], error: null }]);
    expect(await claimOwnerBookingAlert(BIZ, "k", "2026-07-27T16:00:00Z", taken)).toEqual({
      claimed: false,
      assigneeMemberId: null
    });

    // A claimed row with nobody assigned yet.
    const { client: unassigned } = fakeDb([
      { data: [{ id: "row-2", assignee_member_id: null }], error: null }
    ]);
    expect(await claimOwnerBookingAlert(BIZ, "k", "2026-07-27T16:00:00Z", unassigned)).toEqual({
      claimed: true,
      assigneeMemberId: null
    });

    const { client: nullData } = fakeDb([{ data: null, error: null }]);
    expect(await claimOwnerBookingAlert(BIZ, "k", "2026-07-27T16:00:00Z", nullData)).toEqual({
      claimed: false,
      assigneeMemberId: null
    });

    const { client: failing } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(
      claimOwnerBookingAlert(BIZ, "k", "2026-07-27T16:00:00Z", failing)
    ).rejects.toThrow("claimOwnerBookingAlert: denied");

    const { client: fallback } = fakeDb([{ data: [], error: null }]);
    mockClientFactory.mockResolvedValue(fallback);
    await claimOwnerBookingAlert(BIZ, "k", "2026-07-27T16:00:00Z");
    expect(mockClientFactory).toHaveBeenCalled();
  });

  it("fills a missing assignee without overwriting one that exists", async () => {
    const { client, calls } = fakeDb([{ data: [{ id: "row-1" }], error: null }]);
    expect(
      await stampAssigneeIfUnset(BIZ, "phone:+14805550100", "2026-07-27T16:00:00Z", "m-ana", client)
    ).toBe(true);
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      assignee_member_id: "m-ana"
    });
    // Conditional on the gap: re-resolving can name someone else, and
    // overwriting would reassign work already on a calendar.
    expect(calls.filter((c) => c.method === "is").map((c) => c.args)).toContainEqual([
      "assignee_member_id",
      null
    ]);

    // An already-assigned booking answers false: a repair, not a reassign.
    const { client: taken } = fakeDb([{ data: [], error: null }]);
    expect(await stampAssigneeIfUnset(BIZ, "k", "2026-07-27T16:00:00Z", "m-ana", taken)).toBe(
      false
    );
    const { client: nullData } = fakeDb([{ data: null, error: null }]);
    expect(await stampAssigneeIfUnset(BIZ, "k", "2026-07-27T16:00:00Z", "m-ana", nullData)).toBe(
      false
    );

    const { client: failing } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(
      stampAssigneeIfUnset(BIZ, "k", "2026-07-27T16:00:00Z", "m-ana", failing)
    ).rejects.toThrow("stampAssigneeIfUnset: denied");

    const { client: fallback } = fakeDb([{ data: [], error: null }]);
    mockClientFactory.mockResolvedValue(fallback);
    await stampAssigneeIfUnset(BIZ, "k", "2026-07-27T16:00:00Z", "m-ana");
    expect(mockClientFactory).toHaveBeenCalled();
  });

  it("stamps who holds the booking when the page assigns one", async () => {
    const { client, calls } = fakeDb([{ data: [{ id: "row-1" }], error: null }]);
    await stampAttendeeContact(
      BIZ,
      "phone:+14805550100",
      "2026-07-27T16:00:00Z",
      {
        name: "Liz",
        assigneeMemberId: "m-ana",
        intakeAnswers: { project: "A" },
        meetingTypeId: "mt-discovery"
      },
      client
    );
    expect(calls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      assignee_member_id: "m-ana",
      intake_answers: { project: "A" },
      // The dashboard and reminders need to know WHICH meeting this was.
      meeting_type_id: "mt-discovery"
    });
  });

  it("stamps the attendee's email and name for reminder addressing", async () => {
    const { client, calls } = fakeDb([{ error: null }]);
    await stampAttendeeContact(
      BIZ,
      "phone:+14805550100",
      "2026-07-27T16:00:00Z",
      { email: " Liz@Example.com ", name: "  Liz  " },
      client
    );
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      // The provenance rides the same write, so reminders can tell page
      // bookings from AI, voice, and synced appointments.
      booking_source: "booking_page",
      attendee_email: "Liz@Example.com",
      attendee_name: "Liz"
    });
  });

  it("still stamps provenance with no contact details, and throws on failure", async () => {
    // A phone-only booking has nothing to write but the provenance, and
    // without it the sweep would never see the booking at all.
    const { client, calls } = fakeDb([{ data: [{ id: "row-1" }], error: null }]);
    await stampAttendeeContact(BIZ, "k", "2026-07-27T16:00:00Z", { email: "  ", name: null }, client);
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      booking_source: "booking_page"
    });

    const { client: partial, calls: partialCalls } = fakeDb([
      { data: [{ id: "row-1" }], error: null }
    ]);
    await stampAttendeeContact(BIZ, "k", "2026-07-27T16:00:00Z", { name: "Liz" }, partial);
    expect(partialCalls.find((c) => c.method === "update")?.args[0]).toEqual({
      booking_source: "booking_page",
      attendee_name: "Liz"
    });

    const { client: failing } = fakeDb([{ error: { message: "denied" } }]);
    await expect(
      stampAttendeeContact(BIZ, "k", "2026-07-27T16:00:00Z", { email: "a@b.co" }, failing)
    ).rejects.toThrow("stampAttendeeContact: denied");
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await stampAttendeeContact(BIZ, "k", "2026-07-27T16:00:00Z", { email: "a@b.co" });
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("intake question settings", () => {
  it("refuses a non-list and stores the NORMALIZED question set", async () => {
    const { client } = fakeDb([{ data: ROW, error: null }]);
    await expect(
      upsertBookingPage(BIZ, { intakeQuestions: "not-a-list" }, client)
    ).rejects.toThrow(/Questions must be a list/);

    const { client: writing, calls } = fakeDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    await upsertBookingPage(
      BIZ,
      {
        intakeQuestions: [
          { id: "project", label: " Project? ", type: "choice", options: ["A", "B"], required: true },
          { id: "junk!", label: "dropped", type: "text", required: false }
        ]
      },
      writing
    );
    // Parsed and re-serialized, never raw: the public page trusts this
    // column's shape.
    expect(calls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      intake_questions: [
        { id: "project", label: "Project?", type: "choice", options: ["A", "B"], required: true }
      ]
    });
  });
});

describe("payment hooks (schema only)", () => {
  it("refuses a bad price, an unknown currency, and payment without a price", async () => {
    const { client } = fakeDb([{ data: ROW, error: null }]);
    for (const [patch, message] of [
      [{ paymentAmountCents: 10 }, /Price must be/],
      [{ paymentAmountCents: 6_000_000 }, /Price must be/],
      [{ paymentAmountCents: 12.5 }, /Price must be/],
      [{ paymentCurrency: "btc" }, /Unsupported currency/],
      // Requiring payment without a price would refuse every booking while
      // telling the owner nothing.
      [{ paymentRequired: true }, /Set a price/],
      [{ paymentRequired: true, paymentAmountCents: null }, /Set a price/]
    ] as Array<[Record<string, unknown>, RegExp]>) {
      await expect(upsertBookingPage(BIZ, patch, client)).rejects.toThrow(message);
    }

    // The RESULTING state is what gets checked: clearing the price on a
    // page ALREADY requiring payment is the same broken state.
    const { client: paidPage } = fakeDb([
      { data: { ...ROW, payment_required: true, payment_amount_cents: 5000 }, error: null }
    ]);
    await expect(
      upsertBookingPage(BIZ, { paymentAmountCents: null }, paidPage)
    ).rejects.toThrow(/Set a price/);

    // And enabling it works when the STORED price already exists.
    const { client: priced } = fakeDb([
      { data: { ...ROW, payment_amount_cents: 5000 }, error: null },
      { data: ROW, error: null }
    ]);
    await expect(
      upsertBookingPage(BIZ, { paymentRequired: true }, priced)
    ).resolves.toBeTruthy();
  });

  it("writes the pair, and lets a price be cleared when payment is off", async () => {
    const { client, calls } = fakeDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    await upsertBookingPage(
      BIZ,
      { paymentRequired: true, paymentAmountCents: 5000, paymentCurrency: "usd" },
      client
    );
    expect(calls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      payment_required: true,
      payment_amount_cents: 5000,
      payment_currency: "usd"
    });

    const { client: clearing, calls: clearingCalls } = fakeDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    await upsertBookingPage(
      BIZ,
      { paymentRequired: false, paymentAmountCents: null },
      clearing
    );
    expect(clearingCalls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      payment_required: false,
      payment_amount_cents: null
    });
  });
});

describe("assignment settings and per-assignee load", () => {
  it("refuses an unknown mode, and a fixed page with nobody named", async () => {
    const { client } = fakeDb([{ data: ROW, error: null }, { data: ROW, error: null }]);
    await expect(
      upsertBookingPage(BIZ, { assignmentMode: "pooled" }, client)
    ).rejects.toThrow(/Unknown assignment mode/);
    // 'fixed' with no employee silently behaves like 'any', whether the
    // employee is cleared, omitted, or blank.
    for (const patch of [
      { assignmentMode: "fixed", employeeId: null },
      { assignmentMode: "fixed", employeeId: "   " }
    ]) {
      await expect(upsertBookingPage(BIZ, patch, client)).rejects.toThrow(/Pick the employee/);
    }

    // Clearing the employee on a page ALREADY fixed is the same mistake
    // as switching to fixed without naming anyone: the resulting state is
    // what gets checked.
    const { client: fixedPage } = fakeDb([
      { data: { ...ROW, assignment_mode: "fixed", employee_id: "m-ana" }, error: null }
    ]);
    await expect(
      upsertBookingPage(BIZ, { employeeId: null }, fixedPage)
    ).rejects.toThrow(/Pick the employee/);

    // Omitted is refused only when the STORED page has nobody either:
    // "keep the employee already on this page" is a legitimate patch.
    const { client: bare } = fakeDb([{ data: { ...ROW, employee_id: null }, error: null }]);
    await expect(
      upsertBookingPage(BIZ, { assignmentMode: "fixed" }, bare)
    ).rejects.toThrow(/Pick the employee/);

    const { client: named } = fakeDb([
      { data: { ...ROW, employee_id: "m-ana" }, error: null },
      { data: ROW, error: null }
    ]);
    await expect(
      upsertBookingPage(BIZ, { assignmentMode: "fixed" }, named)
    ).resolves.toBeTruthy();

    // A cleared employee on an unassigned page stays legal.
    const { client: anyPage } = fakeDb([
      { data: { ...ROW }, error: null },
      { data: ROW, error: null }
    ]);
    await expect(upsertBookingPage(BIZ, { employeeId: null }, anyPage)).resolves.toBeTruthy();
  });

  it("writes the mode and the employee", async () => {
    const { client, calls } = fakeDb([{ data: ROW, error: null }, { data: ROW, error: null }]);
    await upsertBookingPage(
      BIZ,
      { assignmentMode: "fixed", employeeId: "22222222-2222-4222-8222-222222222222" },
      client
    );
    expect(calls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      assignment_mode: "fixed",
      employee_id: "22222222-2222-4222-8222-222222222222"
    });

    const { client: toggling, calls: toggleCalls } = fakeDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    await upsertBookingPage(BIZ, { notifyAssignee: false }, toggling);
    expect(toggleCalls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      notify_assignee: false
    });
  });

  it("counts each employee's upcoming assigned bookings", async () => {
    const { client } = fakeDb([
      {
        data: [
          { assignee_member_id: "m-ana" },
          { assignee_member_id: "m-ana" },
          { assignee_member_id: "m-ben" },
          // Defensive: a null slips through the filter in no scenario, but
          // it must never become a "null" bucket.
          { assignee_member_id: null }
        ],
        error: null
      }
    ]);
    const counts = await countUpcomingByAssignee(BIZ, client);
    expect(counts.get("m-ana")).toBe(2);
    expect(counts.get("m-ben")).toBe(1);
    expect(counts.size).toBe(2);
  });

  it("answers an empty map with nothing booked, and throws on a read failure", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect((await countUpcomingByAssignee(BIZ, client)).size).toBe(0);

    const { client: failing } = fakeDb([{ data: null, error: { message: "rls" } }]);
    await expect(countUpcomingByAssignee(BIZ, failing)).rejects.toThrow(
      "countUpcomingByAssignee: rls"
    );
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ data: [], error: null }]);
    mockClientFactory.mockResolvedValue(client);
    expect((await countUpcomingByAssignee(BIZ)).size).toBe(0);
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

/**
 * The by-row-id assignee stamp (AI door + broadcast "1" claims). Same CAS
 * contract as stampAssigneeIfUnset: a raced or duplicate write can never
 * reassign a held booking.
 */
describe("stampAssigneeByClaimId", () => {
  it("stamps only while unheld, and reports which happened", async () => {
    const { client, calls } = fakeDb([{ data: [{ id: "row-1" }], error: null }]);
    expect(await stampAssigneeByClaimId("row-1", "m-ana", client)).toBe(true);
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({
      assignee_member_id: "m-ana"
    });
    expect(calls.filter((c) => c.method === "is").map((c) => c.args)).toContainEqual([
      "assignee_member_id",
      null
    ]);

    const { client: taken } = fakeDb([{ data: [], error: null }]);
    expect(await stampAssigneeByClaimId("row-1", "m-ana", taken)).toBe(false);
    const { client: nullData } = fakeDb([{ data: null, error: null }]);
    expect(await stampAssigneeByClaimId("row-1", "m-ana", nullData)).toBe(false);

    const { client: failing } = fakeDb([{ data: null, error: { message: "denied" } }]);
    await expect(stampAssigneeByClaimId("row-1", "m-ana", failing)).rejects.toThrow(
      "stampAssigneeByClaimId: denied"
    );

    const { client: fallback } = fakeDb([{ data: [], error: null }]);
    mockClientFactory.mockResolvedValue(fallback);
    await stampAssigneeByClaimId("row-1", "m-ana");
    expect(mockClientFactory).toHaveBeenCalled();
  });
});
