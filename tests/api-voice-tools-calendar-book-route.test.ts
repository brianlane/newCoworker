/**
 * Voice-bridge calendar book adapter
 * (src/app/api/voice/tools/calendar/book/route.ts): the model-facing
 * guidance attached to notable booking outcomes. Born from the Truly
 * Insurance double-booking (2026-07-15): the bridge timed out a SLOW but
 * ultimately successful booking, the model told the caller the time was
 * "no longer available", and a second slot got booked — the timeout-retry
 * protocol (bridge) plus the `already_booked` / `booking_in_progress`
 * guidance here is what makes an identical retry safe and honest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

vi.mock("@/lib/calendar-tools/handlers", () => ({
  bookCalendarAppointment: vi.fn()
}));

import { POST } from "@/app/api/voice/tools/calendar/book/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { bookCalendarAppointment } from "@/lib/calendar-tools/handlers";

const BIZ = "11111111-1111-4111-8111-111111111111";

const ARGS = {
  startIso: "2026-07-15T15:00:00.000Z",
  endIso: "2026-07-15T15:30:00.000Z",
  summary: "Insurance consultation",
  attendeeName: "Aurangzeb Khan"
};

function req(args: unknown = ARGS) {
  return new Request("http://localhost/api/voice/tools/calendar/book", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gw" },
    body: JSON.stringify({ businessId: BIZ, callerE164: "+16138540807", args })
  });
}

describe("POST /api/voice/tools/calendar/book — outcome guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
  });

  it("passes a plain success through untouched (with the caller ANI as fallback phone)", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: true,
      data: { eventId: "ev-1", inviteEmail: "azkhan15@hotmail.com" }
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { eventId: "ev-1", inviteEmail: "azkhan15@hotmail.com" }
    });
    expect(bookCalendarAppointment).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ summary: ARGS.summary }),
      "+16138540807",
      // Voice surface: unowned-contact bookings page the owner.
      { alertSurface: "voice" }
    );
  });

  it("already_booked (idempotent retry after a timeout) → treat as confirmed, never re-book", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: true,
      detail: "already_booked",
      data: { eventId: "ev-1", deduplicated: true }
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain("ALREADY booked");
    expect(body.message).toContain("never book it");
  });

  it("booking_in_progress → do NOT declare the time unavailable; retry the same args", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: false,
      detail: "booking_in_progress"
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("STILL COMPLETING");
    expect(body.message).toContain("SAME arguments");
  });

  it("keeps the availability framing for a real calendar_book_failed (HTTP 500)", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_book_failed"
    });
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toContain("no longer available");
  });

  it("keeps the notify_team framing for calendar_not_connected", async () => {
    vi.mocked(bookCalendarAppointment).mockResolvedValue({
      ok: false,
      detail: "calendar_not_connected"
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("No calendar is connected");
  });

  it("refuses when the Settings toggle disabled the tool", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await POST(req());
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(bookCalendarAppointment).not.toHaveBeenCalled();
  });

  it("rejects invalid args and a bad envelope", async () => {
    const badArgs = await POST(req({ ...ARGS, startIso: "tomorrow at 3" }));
    expect(badArgs.status).toBe(400);
    expect(bookCalendarAppointment).not.toHaveBeenCalled();

    const badEnvelope = await POST(
      new Request("http://localhost/api/voice/tools/calendar/book", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer gw" },
        body: JSON.stringify({ args: ARGS })
      })
    );
    expect(badEnvelope.status).toBe(400);
  });
});
