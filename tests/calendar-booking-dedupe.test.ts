import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  BOOKING_DEDUPE_WINDOW_MS,
  BOOKING_IN_FLIGHT_TTL_MS,
  bookingAttendeeKey,
  claimBookingDedupe,
  CONFIRM_MAX_ATTEMPTS,
  confirmBookingDedupe,
  deleteBookingClaim,
  deleteBookingClaimsByEvent,
  findUpcomingBookingClaim,
  findUpcomingBookingClaimByPhone,
  findZoomMeetingIdByEvent,
  recordExternalBookingClaim,
  releaseBookingDedupe,
  rescheduleBookingClaim
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
    for (const m of ["insert", "select", "update", "delete", "eq", "neq", "is", "not", "gte", "like", "order", "limit"]) {
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

  it("reclaims an expired confirmed row in place via compare-and-swap on created_at", async () => {
    const staleIso = olderThan(BOOKING_DEDUPE_WINDOW_MS);
    const calls = scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: { id: "row-1", event_id: "evt-old", created_at: staleIso }, error: null },
      { data: { id: "row-1" }, error: null } // reclaim CAS matched
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({ kind: "claimed", id: "row-1" });
    const update = calls.find((c) => c.name === "update");
    expect((update?.args[0] as { event_id: unknown }).event_id).toBeNull();
    // The CAS predicate: the update must be conditioned on the snapshot's
    // created_at so a rival reclaim (which bumps it) makes ours match nothing.
    const eqCreatedAt = calls.find((c) => c.name === "eq" && c.args[0] === "created_at");
    expect(eqCreatedAt?.args[1]).toBe(staleIso);
  });

  it("reclaims a dead unconfirmed claim after the in-flight TTL", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      {
        data: { id: "row-1", event_id: null, created_at: olderThan(BOOKING_IN_FLIGHT_TTL_MS) },
        error: null
      },
      { data: { id: "row-1" }, error: null }
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({ kind: "claimed", id: "row-1" });
  });

  it("losing the reclaim CAS to a rival claimant reports in_flight, never a parallel claim", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      {
        data: { id: "row-1", event_id: null, created_at: olderThan(BOOKING_IN_FLIGHT_TTL_MS) },
        error: null
      },
      { data: null, error: null } // CAS matched zero rows: rival already reclaimed
    ]);
    expect(await claimBookingDedupe(BIZ, KEY, START)).toEqual({ kind: "in_flight" });
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
  it("stamps the event id on the claim row (first attempt, no retries)", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await confirmBookingDedupe("row-1", "evt-9");
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ event_id: "evt-9" });
    const eq = calls.find((c) => c.name === "eq");
    expect(eq?.args).toEqual(["id", "row-1"]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("stamps the booking's Zoom meeting id alongside the event id when present", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await confirmBookingDedupe("row-1", "evt-9", "zm-1");
    const update = calls.find((c) => c.name === "update");
    expect(update?.args[0]).toEqual({ event_id: "evt-9", zoom_meeting_id: "zm-1" });
  });

  it("retries a failed confirm and succeeds without escalating", async () => {
    // A lost confirm re-opens the duplicate window after the in-flight TTL
    // (Bugbot High on PR #566) — one transient DB error must not be enough
    // to get there.
    scriptClient([
      { data: null, error: { message: "transient" } },
      { data: null, error: null }
    ]);
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("escalates to error-level after exhausting retries (update errors)", async () => {
    scriptClient([
      { data: null, error: { message: "boom-1" } },
      { data: null, error: { message: "boom-2" } },
      { data: null, error: { message: "boom-3" } }
    ]);
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(CONFIRM_MAX_ATTEMPTS);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("escalates after exhausting retries on client blow-ups (Error and non-Error)", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(CONFIRM_MAX_ATTEMPTS);
    expect(logger.error).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await confirmBookingDedupe("row-1", "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(CONFIRM_MAX_ATTEMPTS);
    expect(logger.error).toHaveBeenCalledTimes(1);
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

describe("findUpcomingBookingClaim (reschedule/cancel event resolution)", () => {
  it("returns the attendee's next confirmed upcoming booking (with its Zoom meeting)", async () => {
    const calls = scriptClient([
      {
        data: {
          id: "row-1",
          event_id: "evt-1",
          start_at: "2026-07-14T20:00:00Z",
          zoom_meeting_id: "zm-1"
        },
        error: null
      }
    ]);
    expect(await findUpcomingBookingClaim(BIZ, KEY)).toEqual({
      id: "row-1",
      eventId: "evt-1",
      startAt: "2026-07-14T20:00:00Z",
      zoomMeetingId: "zm-1"
    });
    // Confirmed rows only (event_id set), upcoming only, soonest first.
    expect(calls.find((c) => c.name === "not")?.args).toEqual(["event_id", "is", null]);
    expect(calls.find((c) => c.name === "gte")?.args[0]).toBe("start_at");
    expect(calls.find((c) => c.name === "order")?.args[0]).toBe("start_at");
  });

  it("normalizes a missing zoom_meeting_id to null (pre-Zoom rows)", async () => {
    scriptClient([
      { data: { id: "row-1", event_id: "evt-1", start_at: "2026-07-14T20:00:00Z" }, error: null }
    ]);
    expect((await findUpcomingBookingClaim(BIZ, KEY))?.zoomMeetingId).toBeNull();
  });

  it("null on no row, read error, or client blow-up", async () => {
    scriptClient([{ data: null, error: null }]);
    expect(await findUpcomingBookingClaim(BIZ, KEY)).toBeNull();

    scriptClient([{ data: null, error: { message: "boom" } }]);
    expect(await findUpcomingBookingClaim(BIZ, KEY)).toBeNull();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    expect(await findUpcomingBookingClaim(BIZ, KEY)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    expect(await findUpcomingBookingClaim(BIZ, KEY)).toBeNull();
  });
});

describe("findUpcomingBookingClaimByPhone (format-tolerant fallback)", () => {
  const ROWS = [
    // Someone else's booking — must be skipped, not matched.
    {
      id: "row-other",
      event_id: "evt-other",
      start_at: "2026-07-14T18:00:00Z",
      attendee_key: "phone:+15550001111"
    },
    // Degenerate key (no digits after the prefix) — skipped.
    { id: "row-bare", event_id: "evt-bare", start_at: "2026-07-14T19:00:00Z", attendee_key: "phone:" },
    // The caller's booking, stored E.164 at booking time.
    {
      id: "row-mine",
      event_id: "evt-mine",
      start_at: "2026-07-14T20:00:00Z",
      attendee_key: "phone:+15485773546"
    }
  ];

  it("matches a differently formatted phone against the stored key and returns the ROW's key", async () => {
    const calls = scriptClient([{ data: ROWS, error: null }]);
    // National pretty-printed form vs the stored E.164 — still a match.
    expect(await findUpcomingBookingClaimByPhone(BIZ, "(548) 577-3546")).toEqual({
      id: "row-mine",
      eventId: "evt-mine",
      startAt: "2026-07-14T20:00:00Z",
      zoomMeetingId: null,
      attendeeKey: "phone:+15485773546"
    });
    const like = calls.find((c) => c.name === "like");
    expect(like?.args).toEqual(["attendee_key", "phone:%"]);
  });

  it("carries the row's Zoom meeting id when present", async () => {
    scriptClient([
      { data: [{ ...ROWS[2], zoom_meeting_id: "zm-9" }], error: null }
    ]);
    expect(
      (await findUpcomingBookingClaimByPhone(BIZ, "+15485773546"))?.zoomMeetingId
    ).toBe("zm-9");
  });

  it("null when no digits, no rows match, or the read fails", async () => {
    expect(await findUpcomingBookingClaimByPhone(BIZ, "ext. abc")).toBeNull();

    scriptClient([{ data: ROWS, error: null }]);
    expect(await findUpcomingBookingClaimByPhone(BIZ, "+16668884444")).toBeNull();

    scriptClient([{ data: null, error: { message: "boom" } }]);
    expect(await findUpcomingBookingClaimByPhone(BIZ, "+15485773546")).toBeNull();

    scriptClient([{ data: null, error: null }]);
    expect(await findUpcomingBookingClaimByPhone(BIZ, "+15485773546")).toBeNull();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    expect(await findUpcomingBookingClaimByPhone(BIZ, "+15485773546")).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    expect(await findUpcomingBookingClaimByPhone(BIZ, "+15485773546")).toBeNull();
  });
});

describe("findZoomMeetingIdByEvent (provider-search Zoom recovery)", () => {
  it("returns the meeting id recorded for the event under ANY attendee key", async () => {
    const calls = scriptClient([{ data: { zoom_meeting_id: "zm-1" }, error: null }]);
    expect(await findZoomMeetingIdByEvent(BIZ, "evt-1")).toBe("zm-1");
    // Only rows that actually carry a meeting id qualify.
    expect(calls.find((c) => c.name === "not")?.args).toEqual(["zoom_meeting_id", "is", null]);
    const eqs = calls.filter((c) => c.name === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["business_id", BIZ]);
    expect(eqs).toContainEqual(["event_id", "evt-1"]);
  });

  it("null on no row, a null id, a read error, or a client blow-up", async () => {
    scriptClient([{ data: null, error: null }]);
    expect(await findZoomMeetingIdByEvent(BIZ, "evt-1")).toBeNull();

    scriptClient([{ data: { zoom_meeting_id: null }, error: null }]);
    expect(await findZoomMeetingIdByEvent(BIZ, "evt-1")).toBeNull();

    scriptClient([{ data: null, error: { message: "boom" } }]);
    expect(await findZoomMeetingIdByEvent(BIZ, "evt-1")).toBeNull();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    expect(await findZoomMeetingIdByEvent(BIZ, "evt-1")).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    expect(await findZoomMeetingIdByEvent(BIZ, "evt-1")).toBeNull();
  });
});

describe("rescheduleBookingClaim", () => {
  it("moves the claim to the new start (created_at refreshed)", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await rescheduleBookingClaim(BIZ, KEY, "row-1", "2026-07-15T20:00:00.000Z");
    const update = calls.find((c) => c.name === "update");
    expect((update?.args[0] as { start_at: string }).start_at).toBe("2026-07-15T20:00:00.000Z");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a unique-index conflict evicts the rival row at the new slot and retries — the MOVED event stays tracked", async () => {
    // The provider event already moved (the attendee holds its updated
    // invitation), so its claim must win the slot; the displaced event
    // resolves later via provider search (Bugbot on PR #577).
    const calls = scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: null, error: null }, // delete the conflicting row
      { data: null, error: null } // retry the move
    ]);
    await rescheduleBookingClaim(BIZ, KEY, "row-1", "2026-07-15T20:00:00.000Z");
    expect(calls.find((c) => c.name === "delete")).toBeTruthy();
    const neq = calls.find((c) => c.name === "neq");
    expect(neq?.args).toEqual(["id", "row-1"]);
    const updates = calls.filter((c) => c.name === "update");
    expect(updates).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs conflict-cleanup failures, retry failures, plain update failures, and client blow-ups", async () => {
    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: null, error: { message: "delete boom" } }
    ]);
    await rescheduleBookingClaim(BIZ, KEY, "row-1", START);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    scriptClient([
      { data: null, error: { code: "23505", message: "dup" } },
      { data: null, error: null },
      { data: null, error: { message: "retry boom" } }
    ]);
    await rescheduleBookingClaim(BIZ, KEY, "row-1", START);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    scriptClient([{ data: null, error: { message: "update boom" } }]);
    await rescheduleBookingClaim(BIZ, KEY, "row-1", START);
    expect(logger.warn).toHaveBeenCalledTimes(3);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await rescheduleBookingClaim(BIZ, KEY, "row-1", START);
    expect(logger.warn).toHaveBeenCalledTimes(4);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await rescheduleBookingClaim(BIZ, KEY, "row-1", START);
    expect(logger.warn).toHaveBeenCalledTimes(5);
  });
});

describe("deleteBookingClaim", () => {
  it("drops the claim row after a cancellation", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await deleteBookingClaim("row-1");
    expect(calls.find((c) => c.name === "delete")).toBeTruthy();
    expect(calls.find((c) => c.name === "eq")?.args).toEqual(["id", "row-1"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and swallows delete errors and client blow-ups", async () => {
    scriptClient([{ data: null, error: { message: "boom" } }]);
    await deleteBookingClaim("row-1");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await deleteBookingClaim("row-1");
    expect(logger.warn).toHaveBeenCalledTimes(2);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await deleteBookingClaim("row-1");
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

describe("deleteBookingClaimsByEvent (canceled/moved slot must not survive under ANY key)", () => {
  it("deletes every claim row recorded for the provider event", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await deleteBookingClaimsByEvent(BIZ, "evt-9");
    expect(calls.find((c) => c.name === "delete")).toBeTruthy();
    const eqs = calls.filter((c) => c.name === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["business_id", BIZ]);
    expect(eqs).toContainEqual(["event_id", "evt-9"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and swallows delete errors and client blow-ups", async () => {
    scriptClient([{ data: null, error: { message: "boom" } }]);
    await deleteBookingClaimsByEvent(BIZ, "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await deleteBookingClaimsByEvent(BIZ, "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(2);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await deleteBookingClaimsByEvent(BIZ, "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

describe("recordExternalBookingClaim (pre-ledger bookings discovered via provider search)", () => {
  it("inserts a confirmed row for the discovered event", async () => {
    const calls = scriptClient([{ data: null, error: null }]);
    await recordExternalBookingClaim(BIZ, KEY, START, "evt-9");
    const insert = calls.find((c) => c.name === "insert");
    expect(insert?.args[0]).toEqual({
      business_id: BIZ,
      attendee_key: KEY,
      start_at: START,
      event_id: "evt-9"
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores unique-index conflicts (an existing claim already covers the slot)", async () => {
    scriptClient([{ data: null, error: { code: "23505", message: "dup" } }]);
    await recordExternalBookingClaim(BIZ, KEY, START, "evt-9");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and swallows other insert errors and client blow-ups", async () => {
    scriptClient([{ data: null, error: { message: "boom" } }]);
    await recordExternalBookingClaim(BIZ, KEY, START, "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await recordExternalBookingClaim(BIZ, KEY, START, "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(2);

    vi.mocked(createSupabaseServiceClient).mockRejectedValue("raw string");
    await recordExternalBookingClaim(BIZ, KEY, START, "evt-9");
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});
