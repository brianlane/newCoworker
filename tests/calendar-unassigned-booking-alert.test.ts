/**
 * Unassigned-booking owner alert
 * (src/lib/calendar-tools/unassigned-booking-alert.ts): owned-contact and
 * disabled-preference skips, the missing-contact = unowned rule, the alert
 * content, and the never-throws contract. The production trigger: Truly
 * Insurance, Jul 21 2026 — the AI booked a real broker call for a lead no
 * one owned, and no human was told the meeting existed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/db/notification-preferences", () => ({
  getNotificationPreferences: vi.fn()
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));

import {
  maybeAlertUnassignedBooking,
  type UnassignedBookingAlertInput
} from "@/lib/calendar-tools/unassigned-booking-alert";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

const INPUT: UnassignedBookingAlertInput = {
  attendeeName: "shabir gulamhussein lukmanji",
  attendeePhone: "+16136067906",
  attendeeEmail: "lukmanji@hotmail.com",
  startIso: "2026-07-22T16:00:00.000Z",
  startLocal: "Wednesday, July 22, 2026 at 12:00 PM EDT",
  summary: "Home and Auto Bundle Quote",
  eventId: "AAMk-evt",
  surface: "sms"
};

type ContactAnswer = { data?: unknown; error?: { message: string } | null };

/** Chainable contacts fake: phone lookup answers first, then email lookup. */
function fakeDb(answers: ContactAnswer[]) {
  return {
    from() {
      const chain: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "or", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = () => {
        const r = answers.shift() ?? { data: null, error: null };
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      };
      return chain;
    }
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchUrgentNotification).mockResolvedValue({ results: [] });
});

describe("maybeAlertUnassignedBooking", () => {
  it("alerts the owner for an unowned contact — full content and payload", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: { owner_employee_id: null } }]),
      getPreferences: vi.fn().mockResolvedValue({ unassigned_booking_alerts: true }) as never
    });
    expect(out).toBe("sent");
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "unassigned_booking",
        summary:
          "Unassigned booking: shabir gulamhussein lukmanji (+16136067906) — Wednesday, July 22, 2026 at 12:00 PM EDT",
        payload: expect.objectContaining({
          attendee_phone: "+16136067906",
          start_iso: "2026-07-22T16:00:00.000Z",
          event_summary: "Home and Auto Bundle Quote",
          event_id: "AAMk-evt",
          surface: "sms",
          contactE164: "+16136067906"
        })
      })
    );
    const call = vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
    expect(call.smsBody).toContain("No teammate owns this lead yet");
    expect(call.emailBody).toContain('booked "Home and Auto Bundle Quote"');
    expect(call.emailSubject).toContain("New appointment needs an owner");
  });

  it("skips when the contact is owned by a teammate", async () => {
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: { owner_employee_id: "emp-1" } }])
    });
    expect(out).toBe("skipped_owned");
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("skips when the toggle is explicitly off — and ONLY then (missing row/column = on)", async () => {
    const disabled = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: { owner_employee_id: null } }]),
      getPreferences: vi.fn().mockResolvedValue({ unassigned_booking_alerts: false }) as never
    });
    expect(disabled).toBe("skipped_disabled");
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();

    // No prefs row at all → defaults → enabled.
    const noRow = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: { owner_employee_id: null } }]),
      getPreferences: vi.fn().mockResolvedValue(null) as never
    });
    expect(noRow).toBe("sent");

    // Row predating the column (undefined) → enabled.
    const legacyRow = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: { owner_employee_id: null } }]),
      getPreferences: vi.fn().mockResolvedValue({}) as never
    });
    expect(legacyRow).toBe("sent");
  });

  it("falls back to the email lookup when the phone finds no contact; no contact at all = unowned", async () => {
    // Phone misses, email finds an OWNED contact → skip.
    const owned = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: null }, { data: { owner_employee_id: "emp-2" } }])
    });
    expect(owned).toBe("skipped_owned");

    // Neither lookup finds a contact → unowned → alert (a booking is exactly
    // when a lead must stop being nobody's).
    const missing = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: null }, { data: null }]),
      getPreferences: vi.fn().mockResolvedValue(null) as never
    });
    expect(missing).toBe("sent");
  });

  it("a phoneless booking goes straight to the email lookup and drops the phone from copy", async () => {
    const out = await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, attendeePhone: null },
      {
        client: fakeDb([{ data: null }]),
        getPreferences: vi.fn().mockResolvedValue(null) as never
      }
    );
    expect(out).toBe("sent");
    const call = vi.mocked(dispatchUrgentNotification).mock.calls[0][0];
    expect(call.summary).toBe(
      "Unassigned booking: shabir gulamhussein lukmanji — Wednesday, July 22, 2026 at 12:00 PM EDT"
    );
    expect(call.payload).not.toHaveProperty("contactE164");
  });

  it("a booking with neither phone nor email counts as unowned (no lookup possible)", async () => {
    const out = await maybeAlertUnassignedBooking(
      BIZ,
      { ...INPUT, attendeePhone: null, attendeeEmail: null },
      { client: fakeDb([]), getPreferences: vi.fn().mockResolvedValue(null) as never }
    );
    expect(out).toBe("sent");
  });

  it("never throws: lookup errors, dispatch failures, and non-Error shapes all answer failed", async () => {
    const lookupErr = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ error: { message: "contacts down" } }])
    });
    expect(lookupErr).toBe("failed");

    // Phone lookup misses, EMAIL lookup errors → failed, still no throw.
    const emailErr = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: null }, { error: { message: "email index down" } }])
    });
    expect(emailErr).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "unassigned-booking alert failed (booking unaffected)",
      expect.objectContaining({ error: expect.stringContaining("email index down") })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "unassigned-booking alert failed (booking unaffected)",
      expect.objectContaining({ businessId: BIZ, error: expect.stringContaining("contacts down") })
    );

    vi.mocked(dispatchUrgentNotification).mockRejectedValueOnce("dispatch string sad");
    const dispatchErr = await maybeAlertUnassignedBooking(BIZ, INPUT, {
      client: fakeDb([{ data: null }, { data: null }]),
      getPreferences: vi.fn().mockResolvedValue(null) as never
    });
    expect(dispatchErr).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "unassigned-booking alert failed (booking unaffected)",
      expect.objectContaining({ error: "dispatch string sad" })
    );
  });

  it("binds the production client, preference read, and dispatcher when no deps are injected", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      fakeDb([{ data: { owner_employee_id: "emp-3" } }])
    );
    const out = await maybeAlertUnassignedBooking(BIZ, INPUT);
    expect(out).toBe("skipped_owned");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(getNotificationPreferences).not.toHaveBeenCalled();
  });
});
