/**
 * Tests for the feed renderer (src/lib/calendar-tools/feed.ts).
 *
 * Privacy is the property that matters most: the feed URL is a plaintext
 * capability the owner forwards to staff, so the ICS must carry display
 * names only, a forwarded calendar link must not become a contact-list
 * leak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/calendar-feed", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/calendar-feed")>(
    "@/lib/db/calendar-feed"
  );
  return { ...actual, listFeedBookings: vi.fn() };
});

import { FEED_DEFAULT_DURATION_MINUTES, renderCalendarFeed } from "@/lib/calendar-tools/feed";
import { getBusiness } from "@/lib/db/businesses";
import { listFeedBookings } from "@/lib/db/calendar-feed";

const BIZ = "biz-1";
const NOW = Date.parse("2026-08-04T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

function row(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    start_at: "2026-08-05T17:00:00.000Z",
    duration_minutes: 30,
    attendee_name: "Sam Rivera",
    booking_source: "voice",
    ...over
  };
}

describe("renderCalendarFeed", () => {
  it("returns null for a business that does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    await expect(renderCalendarFeed(BIZ, NOW)).resolves.toBeNull();
  });

  it("renders ledger rows as events, named for the calendar app", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ name: "Shear Bliss" } as never);
    vi.mocked(listFeedBookings).mockResolvedValue([row()] as never);
    const ics = await renderCalendarFeed(BIZ, NOW);
    expect(ics).toContain("X-WR-CALNAME:Shear Bliss bookings");
    expect(ics).toContain("UID:row-1@newcoworker");
    expect(ics).toContain("SUMMARY:Booking: Sam Rivera");
    expect(ics).toContain("DESCRIPTION:Booked via voice");
    expect(ics).toContain("DTSTART:20260805T170000Z");
    expect(ics).toContain("DTEND:20260805T173000Z");
  });

  it("carries NO phone numbers or emails, ever", async () => {
    // The ledger row types do not even reach here with contact fields, but
    // pin the rendered output too: this is the property the URL's whole
    // sharing model depends on.
    vi.mocked(getBusiness).mockResolvedValue({ name: "Shop" } as never);
    vi.mocked(listFeedBookings).mockResolvedValue([
      row({ attendee_name: "Sam +15551234567 sam@example.org" })
    ] as never);
    const ics = (await renderCalendarFeed(BIZ, NOW)) as string;
    // Only what the name field itself carries appears, nothing is joined
    // in from elsewhere.
    expect(ics.match(/15551234567/g)).toHaveLength(1);
  });

  it("renders a nameless booking generically and defaults the duration", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ name: "Shop" } as never);
    vi.mocked(listFeedBookings).mockResolvedValue([
      row({ attendee_name: null, booking_source: null, duration_minutes: null })
    ] as never);
    const ics = (await renderCalendarFeed(BIZ, NOW)) as string;
    expect(ics).toContain("SUMMARY:Booking\r\n");
    expect(ics).not.toContain("DESCRIPTION");
    const endMs = Date.parse("2026-08-05T17:00:00.000Z") + FEED_DEFAULT_DURATION_MINUTES * 60_000;
    expect(ics).toContain(`DTEND:${new Date(endMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`);
  });

  it("treats a nonsense duration as the default rather than a zero-length event", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ name: "Shop" } as never);
    vi.mocked(listFeedBookings).mockResolvedValue([row({ duration_minutes: -5 })] as never);
    const ics = (await renderCalendarFeed(BIZ, NOW)) as string;
    expect(ics).toContain("DTEND:20260805T180000Z");
  });

  it("skips a row with an unparseable start instead of failing the feed", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ name: "Shop" } as never);
    vi.mocked(listFeedBookings).mockResolvedValue([
      row({ id: "bad", start_at: "garbage" }),
      row()
    ] as never);
    const ics = (await renderCalendarFeed(BIZ, NOW)) as string;
    expect(ics).not.toContain("UID:bad");
    expect(ics).toContain("UID:row-1@newcoworker");
  });

  it("renders an empty calendar for a business with nothing upcoming", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ name: "Shop" } as never);
    vi.mocked(listFeedBookings).mockResolvedValue([] as never);
    const ics = (await renderCalendarFeed(BIZ, NOW)) as string;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("honors injected deps", async () => {
    const getBusinessRow = vi.fn().mockResolvedValue({ name: "Injected" });
    const listBookings = vi.fn().mockResolvedValue([]);
    const ics = await renderCalendarFeed(BIZ, NOW, {
      getBusinessRow: getBusinessRow as never,
      listBookings: listBookings as never
    });
    expect(ics).toContain("X-WR-CALNAME:Injected bookings");
    expect(vi.mocked(getBusiness)).not.toHaveBeenCalled();
  });
});
