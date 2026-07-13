import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  BOOKING_DEDUPE_WINDOW_MS,
  BOOKING_IN_FLIGHT_TTL_MS,
  bookingAttendeeKey,
  claimBookingDedupe,
  confirmBookingDedupe,
  releaseBookingDedupe
} from "@/lib/calendar-tools/booking-dedupe";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/**
 * Idempotency ledger for calendar_book_appointment. The 2026-07-13 incident:
 * worker-retried model turns re-ran a succeeded booking tool call, creating
 * FOUR identical Outlook events. The ledger makes a repeat attempt inside the
 * dedupe window return the recorded event instead of booking again — and it
 * must FAIL OPEN on every ledger error, because a blocked booking is worse
 * than a missed dedupe.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY = "phone:+15485773546";
const START = "2026-07-13T20:00:00.000Z";

type Scripted = { data?: unknown; error?: { code?: string; message: string } | null };

/**
 * Chainable supabase fake: every builder method records and returns the
 * builder; each terminal await (maybeSingle() or awaiting the builder
 * directly) consumes the next scripted result.
 */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["insert", "select", "update", "delete", "eq", "is"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = () => Promise.resolve(next());
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

function scriptClient(results: Scripted[]) {
  const { db, calls } = makeDb(results);
  vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
  return calls;
}

const freshIso = () => new Date().toISOString();
const olderThan = (ms: number) => new Date(Date.now() - ms - 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bookingAttendeeKey", () => {
  it("prefers phone, then email (lowercased), then name (lowercased), then anonymous", () => {
    expect(bookingAttendeeKey("+15551234567", "a@b.co", "Joe")).toBe("phone:+15551234567");
    expect(bookingAttendeeKey("  ", "Joe@B.Co ", "Joe")).toBe("email:joe@b.co");
    expect(bookingAttendeeKey(null, undefined, " Joe Smith ")).toBe("name:joe smith");
    expect(bookingAttendeeKey(null, null, "  ")).toBe("anonymous");
  });
});

describe("claimBookingDedupe", () => {
  it("claims a free slot (insert succeeds)", async () => {
    const calls = scriptClient([{ data: { id: "row-1" }, error: null }]);
    const claim = await claimBookingDedupe(BIZ, KEY, START);
    expect(claim).toEqual({ kind: "claimed", id: "row-1" });
    const insert = calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toEqual({ business_id: BIZ, attendee_key: KEY, start_at: START });
  });

  it("fails open (null) on a non-unique-violation insert error", async () => {
    scriptClient([{ data: null, error: { code: "57014", message: "canceled" } }]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns the recorded event for a fresh confirmed duplicate", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: { id: "row-1", event_id: "evt-1", created_at: freshIso() }, error: null }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({
      kind: "duplicate",
      eventId: "evt-1"
    });
  });

  it("reports in_flight for a fresh unconfirmed claim", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: { id: "row-1", event_id: null, created_at: freshIso() }, error: null }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({ kind: "in_flight" });
  });

  it("reclaims an expired confirmed row in place", async () => {
    const calls = scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      {
        data: { id: "row-1", event_id: "evt-old", created_at: olderThan(BOOKING_DEDUPE_WINDOW_MS) },
        error: null
      },
      { data: null, error: null } // reclaim update
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({ kind: "claimed", id: "row-1" });
    const update = calls.find((c) => c.name === "update");
    expect((update?.args[0] as { event_id: unknown }).event_id).toBeNull();
  });

  it("reclaims a dead unconfirmed claim after the in-flight TTL", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      {
        data: { id: "row-1", event_id: null, created_at: olderThan(BOOKING_IN_FLIGHT_TTL_MS) },
        error: null
      },
      { data: null, error: null }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({ kind: "claimed", id: "row-1" });
  });

  it("fails open when the conflict row cannot be read (error or missing)", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: null, error: { message: "read boom" } }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toBeNull();

    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: null, error: null }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toBeNull();
  });

  it("fails open when the reclaim update fails", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      {
        data: { id: "row-1", event_id: null, created_at: olderThan(BOOKING_IN_FLIGHT_TTL_MS) },
        error: null
      },
      { data: null, error: { message: "update boom" } }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("fails open when the client itself blows up", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    expect(await claimBookingDedupe(BIZ, KEY, START)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    expect(await claimBookingDedupe(BIZ, KEY, START)).toBeNull();
  });
});

describe("confirmBookingDedupe", () => {
  it("stamps the event id on the claim row", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await confirmBookingDedupe("row-1", "evt-9");
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ event_id: "evt-9" });
    const eq = calls.find((c) => c.name === "eq");
    expect(eq?.args).toEqual(["id", "row-1"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and swallows update errors and client blow-ups", async () => {
    scriptClient([{ data: null, error: { message: "boom" } }]);
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(2);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

describe("releaseBookingDedupe", () => {
  it("deletes only an unconfirmed claim (event_id still null)", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await releaseBookingDedupe("row-1");
    expect(calls.find((c) => c.name === "delete")).toBeTruthy();
    expect(calls.find((c) => c.name === "eq")?.args).toEqual(["id", "row-1"]);
    expect(calls.find((c) => c.name === "is")?.args).toEqual(["event_id", null]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and swallows delete errors and client blow-ups", async () => {
    scriptClient([{ data: null, error: { message: "boom" } }]);
    await releaseBookingDedupe("row-1");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await releaseBookingDedupe("row-1");
    expect(logger.warn).toHaveBeenCalledTimes(2);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await releaseBookingDedupe("row-1");
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});
