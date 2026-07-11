import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/caldav-connections", () => ({
  getActiveCaldavConnection: vi.fn(),
  upsertCaldavConnection: vi.fn()
}));
vi.mock("@/lib/caldav/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/caldav/client")>(
    "@/lib/caldav/client"
  );
  return {
    ...actual,
    createCaldavEvent: vi.fn(),
    discoverEventCalendars: vi.fn(),
    fetchCaldavBusy: vi.fn()
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
  getActiveCaldavConnection,
  upsertCaldavConnection
} from "@/lib/db/caldav-connections";
import {
  CaldavApiError,
  createCaldavEvent,
  discoverEventCalendars,
  fetchCaldavBusy
} from "@/lib/caldav/client";
import {
  bookCaldavAppointment,
  getCaldavBusyBlocks
} from "@/lib/calendar-tools/caldav";

const BIZ = "11111111-1111-4111-8111-111111111111";

const ROW = {
  id: "cd-1",
  business_id: BIZ,
  server_url: "https://caldav.icloud.com/",
  username: "owner@icloud.com",
  password: "app-pass",
  calendar_url: "https://p42.example.com/cals/work/",
  calendar_name: "Work",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

const WINDOW_START = new Date("2026-07-14T00:00:00Z");
const WINDOW_END = new Date("2026-07-15T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCaldavBusyBlocks", () => {
  it("returns calendar_not_connected when no active row exists", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue(null);
    const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
    expect(res).toEqual({
      ok: false,
      result: { ok: false, detail: "calendar_not_connected" }
    });
  });

  it("uses the cached calendar URL and returns busy blocks", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue(ROW as never);
    const busy = [{ start: WINDOW_START, end: WINDOW_END }];
    vi.mocked(fetchCaldavBusy).mockResolvedValue(busy);
    const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
    expect(res).toEqual({ ok: true, busy });
    expect(discoverEventCalendars).not.toHaveBeenCalled();
    expect(fetchCaldavBusy).toHaveBeenCalledWith(
      { serverUrl: ROW.server_url, username: ROW.username, password: ROW.password },
      "https://p42.example.com/cals/work/",
      WINDOW_START,
      WINDOW_END
    );
  });

  it("re-discovers and persists the calendar when the cache is empty", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue({
      ...ROW,
      calendar_url: null,
      calendar_name: null
    } as never);
    vi.mocked(discoverEventCalendars).mockResolvedValue([
      { url: "https://p42.example.com/cals/home/", name: "Home" }
    ]);
    vi.mocked(fetchCaldavBusy).mockResolvedValue([]);
    const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
    expect(res).toEqual({ ok: true, busy: [] });
    expect(upsertCaldavConnection).toHaveBeenCalledWith({
      businessId: BIZ,
      calendarUrl: "https://p42.example.com/cals/home/",
      calendarName: "Home"
    });
  });

  it("still serves the call when the cache persist fails (Error and non-Error)", async () => {
    for (const rejection of [new Error("db down"), "string failure"]) {
      vi.mocked(getActiveCaldavConnection).mockResolvedValue({
        ...ROW,
        calendar_url: null
      } as never);
      vi.mocked(discoverEventCalendars).mockResolvedValue([
        { url: "https://p42.example.com/cals/home/", name: "Home" }
      ]);
      vi.mocked(upsertCaldavConnection).mockRejectedValue(rejection);
      vi.mocked(fetchCaldavBusy).mockResolvedValue([]);
      const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
      expect(res).toEqual({ ok: true, busy: [] });
    }
  });

  it("returns calendar_not_connected when discovery finds no calendars", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue({
      ...ROW,
      calendar_url: null
    } as never);
    vi.mocked(discoverEventCalendars).mockResolvedValue([]);
    const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
    expect(res).toEqual({
      ok: false,
      result: { ok: false, detail: "calendar_not_connected" }
    });
  });

  it("maps auth/blocked transport errors to calendar_not_connected", async () => {
    for (const code of ["auth_failed", "blocked_url"] as const) {
      vi.mocked(getActiveCaldavConnection).mockResolvedValue(ROW as never);
      vi.mocked(fetchCaldavBusy).mockRejectedValue(new CaldavApiError(code, "nope"));
      const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
      expect(res).toEqual({
        ok: false,
        result: { ok: false, detail: "calendar_not_connected" }
      });
    }
  });

  it("maps other failures to calendar_lookup_failed", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue(ROW as never);
    vi.mocked(fetchCaldavBusy).mockRejectedValue(new Error("500"));
    const res = await getCaldavBusyBlocks(BIZ, WINDOW_START, WINDOW_END);
    expect(res).toEqual({
      ok: false,
      result: { ok: false, detail: "calendar_lookup_failed" }
    });
  });
});

describe("bookCaldavAppointment", () => {
  const ARGS = {
    startIso: "2026-07-14T16:00:00.000Z",
    endIso: "2026-07-14T16:30:00.000Z",
    summary: "Consult with Amy",
    description: "Attendee: Amy"
  };

  it("returns calendar_not_connected when no active row exists", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue(null);
    expect(await bookCaldavAppointment(BIZ, ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("returns calendar_not_connected when no calendar can be resolved", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue({
      ...ROW,
      calendar_url: null
    } as never);
    vi.mocked(discoverEventCalendars).mockResolvedValue([]);
    expect(await bookCaldavAppointment(BIZ, ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });
  });

  it("creates the event and returns the standard success payload", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue(ROW as never);
    vi.mocked(createCaldavEvent).mockImplementation(async (_c, _u, event) => ({
      eventUid: event.uid
    }));
    const res = await bookCaldavAppointment(BIZ, ARGS);
    expect(res.ok).toBe(true);
    const data = res.data as { eventId: string; provider: string; calendar: string };
    expect(data.eventId).toMatch(/^newcoworker-/);
    expect(data.provider).toBe("caldav");
    expect(data.calendar).toBe("Work");
    const [, calendarUrl, event] = vi.mocked(createCaldavEvent).mock.calls[0];
    expect(calendarUrl).toBe("https://p42.example.com/cals/work/");
    expect(event).toMatchObject({
      summary: ARGS.summary,
      description: ARGS.description,
      startIso: ARGS.startIso,
      endIso: ARGS.endIso
    });
  });

  it("labels the calendar 'caldav' when the row has no calendar name", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue({
      ...ROW,
      calendar_name: null
    } as never);
    vi.mocked(createCaldavEvent).mockResolvedValue({ eventUid: "newcoworker-x" });
    const res = await bookCaldavAppointment(BIZ, ARGS);
    expect((res.data as { calendar: string }).calendar).toBe("caldav");
  });

  it("reports the freshly DISCOVERED calendar name when booking had to re-discover", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue({
      ...ROW,
      calendar_url: null,
      calendar_name: null
    } as never);
    vi.mocked(discoverEventCalendars).mockResolvedValue([
      { url: "https://p42.example.com/cals/home/", name: "Home" }
    ]);
    vi.mocked(createCaldavEvent).mockResolvedValue({ eventUid: "newcoworker-y" });
    const res = await bookCaldavAppointment(BIZ, ARGS);
    expect(res.ok).toBe(true);
    expect((res.data as { calendar: string }).calendar).toBe("Home");
    const [, calendarUrl] = vi.mocked(createCaldavEvent).mock.calls[0];
    expect(calendarUrl).toBe("https://p42.example.com/cals/home/");
  });

  it("maps auth errors to calendar_not_connected and others to calendar_book_failed", async () => {
    vi.mocked(getActiveCaldavConnection).mockResolvedValue(ROW as never);
    vi.mocked(createCaldavEvent).mockRejectedValue(new CaldavApiError("auth_failed", "no"));
    expect(await bookCaldavAppointment(BIZ, ARGS)).toEqual({
      ok: false,
      detail: "calendar_not_connected"
    });

    vi.mocked(createCaldavEvent).mockRejectedValue("string failure");
    expect(await bookCaldavAppointment(BIZ, ARGS)).toEqual({
      ok: false,
      detail: "calendar_book_failed"
    });
  });
});
