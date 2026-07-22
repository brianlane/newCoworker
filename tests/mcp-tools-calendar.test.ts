import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/calendar-tools/handlers", () => ({
  findCalendarSlots: vi.fn(),
  bookCalendarAppointment: vi.fn()
}));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  calendarBookAppointmentTool,
  calendarFailureMessage,
  calendarFindSlotsTool
} from "@/lib/mcp/tools/calendar";
import {
  bookCalendarAppointment,
  findCalendarSlots
} from "@/lib/calendar-tools/handlers";

const AUTH = { userId: "user-1", email: "owner@biz.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMcpBusinessRole).mockResolvedValue("owner");
});

describe("calendarFailureMessage", () => {
  it("maps the calendar core's detail codes to guidance", () => {
    expect(calendarFailureMessage("calendar_not_connected")).toMatch(/Integrations page/);
    expect(calendarFailureMessage("calendar_book_failed")).toMatch(/no longer available/);
    expect(calendarFailureMessage("invalid_window")).toBe(
      "Calendar request failed (invalid_window)."
    );
    expect(calendarFailureMessage(undefined)).toBe("Calendar request failed.");
  });
});

describe("calendar_find_slots", () => {
  it("returns the core's slot data", async () => {
    const data = { slots: [{ startIso: "s", endIso: "e" }], timezone: "UTC" };
    vi.mocked(findCalendarSlots).mockResolvedValue({ ok: true, data });
    const result = await calendarFindSlotsTool.handler(
      { durationMinutes: 30, purpose: "consult" },
      AUTH
    );
    expect(findCalendarSlots).toHaveBeenCalledWith("biz-1", {
      durationMinutes: 30,
      earliest: undefined,
      latest: undefined,
      purpose: "consult",
      timezone: undefined,
      serviceId: undefined
    });
    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "operate_messages");
    expect(result).toEqual(data);
  });

  it("converts core failures into tool errors", async () => {
    vi.mocked(findCalendarSlots).mockResolvedValue({
      ok: false,
      detail: "calendar_not_connected"
    });
    await expect(
      calendarFindSlotsTool.handler({ durationMinutes: 30 }, AUTH)
    ).rejects.toThrow(/No calendar is connected/);
  });
});

describe("calendar_book_appointment", () => {
  const ARGS = {
    startIso: "2026-08-01T10:00:00-04:00",
    endIso: "2026-08-01T10:30:00-04:00",
    summary: "Consult",
    attendeeName: "Ann"
  };

  it("books through the shared core", async () => {
    const data = { eventId: "evt-1" };
    vi.mocked(bookCalendarAppointment).mockResolvedValue({ ok: true, data });
    const result = await calendarBookAppointmentTool.handler(ARGS, AUTH);
    expect(bookCalendarAppointment).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ summary: "Consult", attendeeName: "Ann" })
    );
    expect(result).toEqual(data);
  });

  it("converts booking failures into re-check guidance", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_book_failed"
    });
    await expect(calendarBookAppointmentTool.handler(ARGS, AUTH)).rejects.toThrow(
      /re-check with calendar_find_slots/
    );
  });

  it("surfaces the core's own message verbatim when it carries one (attendee duplicate guard)", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: false,
      detail: "attendee_already_booked",
      message:
        "This person already has an upcoming appointment: Wednesday, July 22, 2026 at 12:00 PM EDT. Do NOT book another one."
    });
    await expect(calendarBookAppointmentTool.handler(ARGS, AUTH)).rejects.toThrow(
      /already has an upcoming appointment: Wednesday, July 22/
    );
  });

  it("passes allowAdditional through to the core", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({ ok: true, data: { eventId: "e" } });
    await calendarBookAppointmentTool.handler({ ...ARGS, allowAdditional: true }, AUTH);
    expect(bookCalendarAppointment).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ allowAdditional: true })
    );
  });
});
