/**
 * The Bookings dashboard endpoint's GET path, which is where an owner's
 * page and its first meeting come into existence.
 *
 * Both provisions are "so the owner lands on something usable": the page
 * exists before it is asked for, and it always has at least one meeting,
 * because meetings are the only way a visitor books.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => ({ success: true })) }));
vi.mock("@/lib/booking-page/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/booking-page/db")>(
    "@/lib/booking-page/db"
  );
  return {
    BookingPageValidationError: actual.BookingPageValidationError,
    getBookingPageForBusiness: vi.fn(),
    listUpcomingBookings: vi.fn(),
    rotateBookingPageToken: vi.fn(),
    upsertBookingPage: vi.fn()
  };
});
vi.mock("@/lib/booking-page/meeting-types", () => ({ ensureDefaultMeetingType: vi.fn() }));
vi.mock("@/lib/booking-page/service", () => ({ probeCalendarAvailability: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn() }));
vi.mock("@/lib/db/implicit-contact-owner", () => ({ resolveImplicitContactOwner: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { GET } from "@/app/api/dashboard/booking-page/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  getBookingPageForBusiness,
  listUpcomingBookings,
  upsertBookingPage
} from "@/lib/booking-page/db";
import { ensureDefaultMeetingType } from "@/lib/booking-page/meeting-types";
import { probeCalendarAvailability } from "@/lib/booking-page/service";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { listTeamMembers } from "@/lib/db/employees";
import { resolveImplicitContactOwner } from "@/lib/db/implicit-contact-owner";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const BASE = "http://localhost/api/dashboard/booking-page";

const mockUser = vi.mocked(getAuthUser);
const mockRole = vi.mocked(requireBusinessRole);
const mockLimit = vi.mocked(rateLimit);
const mockGetPage = vi.mocked(getBookingPageForBusiness);
const mockUpsert = vi.mocked(upsertBookingPage);
const mockEnsureMeeting = vi.mocked(ensureDefaultMeetingType);
const mockUpcoming = vi.mocked(listUpcomingBookings);
const mockProbe = vi.mocked(probeCalendarAvailability);
const mockConn = vi.mocked(resolveCalendarConnection);
const mockRoster = vi.mocked(listTeamMembers);
const mockWarn = vi.mocked(logger.warn);

const page = { id: "page-1", business_id: BIZ, token: "tok", enabled: true } as never;

function get(): Promise<Response> {
  return GET(new Request(`${BASE}?businessId=${BIZ}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.mockResolvedValue({ id: "u-1", isAdmin: false } as never);
  mockRole.mockResolvedValue(undefined as never);
  mockLimit.mockReturnValue({ success: true } as never);
  mockGetPage.mockResolvedValue(page);
  mockUpsert.mockResolvedValue(page);
  mockEnsureMeeting.mockResolvedValue({ meetingType: null, pageQuestionsCleared: false });
  mockUpcoming.mockResolvedValue([]);
  mockProbe.mockResolvedValue("ok" as never);
  mockConn.mockResolvedValue(null as never);
  mockRoster.mockResolvedValue([]);
  // Default: not a solo-owner business.
  vi.mocked(resolveImplicitContactOwner).mockResolvedValue(null);
});

describe("GET /api/dashboard/booking-page", () => {
  it("gives an existing page its first meeting on the way out", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { page: { id: "page-1" } } });
    expect(mockEnsureMeeting).toHaveBeenCalledWith(page);
    // The page already existed, so nothing was created for it.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("answers the solo-owner hint, reusing the members already loaded", async () => {
    const members = [
      { id: "mem-owner", name: "Brian", phone_e164: "+16026866672", active: true }
    ];
    mockRoster.mockResolvedValue(members as never);
    vi.mocked(resolveImplicitContactOwner).mockResolvedValue({ id: "mem-owner", name: "Brian" });
    const res = await get();
    expect(await res.json()).toMatchObject({
      data: { implicitOwner: { id: "mem-owner", name: "Brian" } }
    });
    // The resolver must receive the roster the route already read: a real
    // team pays zero extra queries for this field.
    expect(resolveImplicitContactOwner).toHaveBeenCalledWith(BIZ, undefined, members);
  });

  it("answers implicitOwner null for a real team", async () => {
    const res = await get();
    expect(await res.json()).toMatchObject({ data: { implicitOwner: null } });
  });

  it("answers with the page as the ensure pass left it", async () => {
    mockGetPage.mockResolvedValue({ ...(page as object), intake_questions: [{ id: "q" }] } as never);
    mockEnsureMeeting.mockResolvedValue({ meetingType: null, pageQuestionsCleared: true });
    const res = await get();
    // The questions moved onto the meetings that were inheriting them, so
    // the dashboard must not keep offering them as the page's.
    expect(await res.json()).toMatchObject({ data: { page: { intake_questions: [] } } });
  });

  it("provisions the page and its meeting together on a first view", async () => {
    mockGetPage.mockResolvedValue(null);
    await get();
    expect(mockUpsert).toHaveBeenCalledWith(BIZ, { enabled: true });
    expect(mockEnsureMeeting).toHaveBeenCalledWith(page);
  });

  it("skips both for a Calendly tenant, whose booking lives elsewhere", async () => {
    mockGetPage.mockResolvedValue(null);
    mockConn.mockResolvedValue({ provider: "calendly" } as never);
    const res = await get();
    expect(await res.json()).toMatchObject({ data: { page: null, calendarProvider: "calendly" } });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockEnsureMeeting).not.toHaveBeenCalled();
  });

  it("still serves the dashboard when the meeting provision fails", async () => {
    mockEnsureMeeting.mockRejectedValue(new Error("insert denied"));
    const res = await get();
    expect(res.status).toBe(200);
    expect(mockWarn).toHaveBeenCalledWith(
      "booking-page: default meeting provision failed",
      expect.objectContaining({ businessId: BIZ, error: "insert denied" })
    );
  });

  it("logs a non-Error rejection as text rather than losing it", async () => {
    mockEnsureMeeting.mockRejectedValue("timeout");
    expect((await get()).status).toBe(200);
    expect(mockWarn).toHaveBeenCalledWith(
      "booking-page: default meeting provision failed",
      expect.objectContaining({ error: "timeout" })
    );
  });

  it("refuses an anonymous caller and rate-limits a hot loop", async () => {
    mockUser.mockResolvedValue(null as never);
    expect((await get()).status).toBe(401);

    mockUser.mockResolvedValue({ id: "u-1", isAdmin: false } as never);
    mockLimit.mockReturnValue({ success: false } as never);
    expect((await get()).status).toBe(429);
  });
});
