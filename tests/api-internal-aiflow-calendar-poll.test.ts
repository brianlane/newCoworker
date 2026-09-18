/**
 * Calendar-poll cron tick also sends the next-day Calendly reconnect reminder
 * so a cadence-gated poll skip cannot starve the email.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/ai-flows/calendar-poll", () => ({ pollCalendarTriggers: vi.fn() }));
vi.mock("@/lib/ai-flows/calendly-booking-goals", () => ({
  sweepCalendlyBookingGoals: vi.fn()
}));
vi.mock("@/lib/calendly/reauth", () => ({ processCalendlyReauthReminders: vi.fn() }));
vi.mock("@/lib/calendar-tools/waitlist-fill", () => ({
  handleObservedCancellation: vi.fn(),
  sweepWaitlist: vi.fn()
}));

import { POST } from "@/app/api/internal/aiflow-calendar-poll/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { pollCalendarTriggers } from "@/lib/ai-flows/calendar-poll";
import { sweepCalendlyBookingGoals } from "@/lib/ai-flows/calendly-booking-goals";
import { processCalendlyReauthReminders } from "@/lib/calendly/reauth";
import { sweepWaitlist } from "@/lib/calendar-tools/waitlist-fill";

function req() {
  return new Request("http://localhost/api/internal/aiflow-calendar-poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

describe("api/internal/aiflow-calendar-poll route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(pollCalendarTriggers).mockResolvedValue({
      flows: 1,
      businesses: 1,
      events: 0,
      enqueued: 0
    });
    vi.mocked(sweepCalendlyBookingGoals).mockResolvedValue({
      businesses: 0,
      swept: 0,
      bookings: 0,
      goalsFired: 0,
      jumpedRuns: 0
    });
    vi.mocked(processCalendlyReauthReminders).mockResolvedValue({
      considered: 1,
      emailed: 0
    });
    vi.mocked(sweepWaitlist).mockResolvedValue({
      lapsedEntries: 0,
      expiredOffers: 0,
      reoffered: 0
    });
  });

  it("403 without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(pollCalendarTriggers).not.toHaveBeenCalled();
    expect(processCalendlyReauthReminders).not.toHaveBeenCalled();
  });

  it("runs poll, booking sweep, waitlist, and Calendly reconnect reminders", async () => {
    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.calendlyReauth).toEqual({ considered: 1, emailed: 0 });
    expect(processCalendlyReauthReminders).toHaveBeenCalledTimes(1);
  });

  it("keeps the poll result when the reminder sender throws", async () => {
    vi.mocked(processCalendlyReauthReminders).mockRejectedValueOnce(new Error("dispatch down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; data: { calendlyReauth: unknown } };
    expect(res.status).toBe(200);
    expect(body.data.calendlyReauth).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
