import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/cal-connections", () => ({
  getCalConnectionByBusiness: vi.fn()
}));
vi.mock("@/lib/cal/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cal/client")>();
  return {
    ...actual,
    listCalEventTypes: vi.fn(),
    listCalSlotStarts: vi.fn(),
    createCalBooking: vi.fn(),
    cancelCalBooking: vi.fn(),
    rescheduleCalBooking: vi.fn(),
    selectCalEventType: vi.fn()
  };
});
vi.mock("@/lib/ai-flows/webhook-events", () => ({
  processWebhookFlowEvent: vi.fn(async () => ({ enqueued: 1 }))
}));

import { getCalConnectionByBusiness } from "@/lib/db/cal-connections";
import {
  CalApiError,
  cancelCalBooking,
  createCalBooking,
  listCalEventTypes,
  listCalSlotStarts,
  rescheduleCalBooking,
  selectCalEventType
} from "@/lib/cal/client";
import { bookCalAppointment, cancelCalAppointment, findCalSlots, rescheduleCalAppointment } from "@/lib/calendar-tools/cal";
import { processCalWebhook } from "@/lib/cal/webhook";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { createHmac } from "node:crypto";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = { id: "cal-1", default_event_type_id: null, time_zone: "America/New_York", webhookSecret: "secret" };

describe("Cal.com calendar tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listCalEventTypes).mockReset();
    vi.mocked(selectCalEventType).mockReset();
  });

  it("finds slots and reports a missing book or auth failure", async () => {
    vi.mocked(getCalConnectionByBusiness).mockResolvedValue(null as never);
    await expect(
      findCalSlots(BIZ, {
        windowStart: new Date("2026-09-26T15:00:00.000Z"),
        windowEnd: new Date("2026-09-26T18:00:00.000Z"),
        durationMinutes: 30,
        timezone: "America/New_York"
      })
    ).resolves.toEqual({ ok: false, detail: "calendar_not_connected" });

    vi.mocked(getCalConnectionByBusiness).mockResolvedValue(CONN as never);
    await expect(
      findCalSlots(BIZ, {
        windowStart: new Date("2026-09-26T18:00:00.000Z"),
        windowEnd: new Date("2026-09-26T15:00:00.000Z"),
        durationMinutes: 30,
        timezone: "America/New_York"
      })
    ).resolves.toEqual({ ok: false, detail: "invalid_window" });

    vi.mocked(listCalEventTypes).mockResolvedValue([]);
    vi.mocked(selectCalEventType).mockReturnValue("no_types");
    await expect(
      findCalSlots(BIZ, {
        windowStart: new Date("2020-01-01T00:00:00.000Z"),
        windowEnd: new Date("2026-09-26T18:00:00.000Z"),
        durationMinutes: 30,
        timezone: "America/New_York"
      })
    ).resolves.toEqual({ ok: false, detail: "cal_no_event_types" });

    vi.mocked(selectCalEventType).mockReturnValue({ id: "9", title: "Intro", lengthMinutes: 30 });
    vi.mocked(listCalSlotStarts).mockResolvedValue(["not-a-date", "2027-09-26T16:00:00.000Z", "2027-09-26T17:00:00.000Z", "2027-09-26T18:00:00.000Z"]);
    const found = await findCalSlots(BIZ, {
      windowStart: new Date("2027-09-26T15:00:00.000Z"),
      windowEnd: new Date("2027-09-26T18:00:00.000Z"),
      durationMinutes: 30,
      purpose: "intro",
      timezone: "America/New_York"
    });
    expect(found.ok).toBe(true);
    expect((found.data as { slots: unknown[] }).slots).toHaveLength(2);

    vi.mocked(listCalEventTypes).mockRejectedValue(new CalApiError("needs_reauth", "no"));
    await expect(
      findCalSlots(BIZ, {
        windowStart: new Date("2020-01-01T00:00:00.000Z"),
        windowEnd: new Date("2026-09-26T18:00:00.000Z"),
        durationMinutes: 30,
        timezone: "America/New_York"
      })
    ).resolves.toEqual({ ok: false, detail: "cal_auth_failed" });

    vi.mocked(listCalEventTypes).mockRejectedValue(new Error("boom"));
    await expect(
      findCalSlots(BIZ, {
        windowStart: new Date("2020-01-01T00:00:00.000Z"),
        windowEnd: new Date("2026-09-26T18:00:00.000Z"),
        durationMinutes: 30,
        timezone: "America/New_York"
      })
    ).rejects.toThrow("boom");
  });

  it("books, cancels, and reschedules", async () => {
    vi.mocked(getCalConnectionByBusiness).mockResolvedValue(CONN as never);
    vi.mocked(selectCalEventType).mockReturnValue({ id: "9", title: "Intro", lengthMinutes: 30 });
    vi.mocked(createCalBooking).mockResolvedValue("bk_1");
    const booked = await bookCalAppointment(
      BIZ,
      {
        startIso: "2026-09-26T16:00:00.000Z",
        endIso: "2026-09-26T16:30:00.000Z",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "a@b.co",
        summary: "Intro",
        notes: "from Quinn"
      },
      "+15551212"
    );
    expect(booked).toMatchObject({ ok: true, data: { eventId: "bk_1", provider: "cal" } });

    vi.mocked(createCalBooking).mockResolvedValue(null);
    await expect(
      bookCalAppointment(BIZ, {
        startIso: "2026-09-26T16:00:00.000Z",
        endIso: "2026-09-26T16:30:00.000Z",
        attendeeName: "",
        summary: ""
      })
    ).resolves.toEqual({ ok: false, detail: "cal_book_failed" });

    vi.mocked(getCalConnectionByBusiness).mockResolvedValue(null as never);
    await expect(cancelCalAppointment(BIZ, "bk_1")).resolves.toEqual({ ok: false, detail: "calendar_not_connected" });
    vi.mocked(getCalConnectionByBusiness).mockResolvedValue(CONN as never);
    vi.mocked(cancelCalBooking).mockResolvedValue(undefined);
    await expect(cancelCalAppointment(BIZ, "bk_1")).resolves.toMatchObject({ ok: true });
    vi.mocked(rescheduleCalBooking).mockResolvedValue("bk_2");
    await expect(rescheduleCalAppointment(BIZ, "bk_1", "2026-09-27T16:00:00.000Z")).resolves.toMatchObject({
      ok: true,
      data: { eventId: "bk_2" }
    });
  });
});

describe("Cal.com webhook processor", () => {
  it("rejects a bad signature and ignores unknown triggers", async () => {
    await expect(processCalWebhook(BIZ, "{}", null, null)).resolves.toEqual({ ok: false, reason: "bad_signature" });
    const body = JSON.stringify({ triggerEvent: "FORM_SUBMITTED" });
    const sig = createHmac("sha256", "secret").update(body).digest("hex");
    await expect(processCalWebhook(BIZ, body, sig, "secret")).resolves.toEqual({
      ok: true,
      ignored: "FORM_SUBMITTED"
    });
    const badBody = "nope";
    const badSig = createHmac("sha256", "secret").update(badBody).digest("hex");
    await expect(processCalWebhook(BIZ, badBody, badSig, "secret")).resolves.toEqual({ ok: true, ignored: "unparsed" });
    const created = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { uid: "bk_1", title: "Intro", attendees: [{ name: "Ada", email: "a@b.co" }] }
    });
    const createdSig = createHmac("sha256", "secret").update(created).digest("hex");
    await expect(processCalWebhook(BIZ, created, createdSig, "secret")).resolves.toEqual({ ok: true });
    expect(processWebhookFlowEvent).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ source: "cal_com", eventId: "bk_1" })
    );
  });
});
