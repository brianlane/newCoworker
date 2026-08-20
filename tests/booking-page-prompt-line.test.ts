/**
 * The coworker's knowledge of its own booking link: vanity slug over raw
 * token, the meetings that name the link, silence when there is no enabled
 * page, and a read failure that costs only the hint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({
  getBookingPageForBusiness: vi.fn(),
  upsertBookingPage: vi.fn()
}));
vi.mock("@/lib/booking-page/meeting-types", async () => {
  const actual = await vi.importActual<typeof import("@/lib/booking-page/meeting-types")>(
    "@/lib/booking-page/meeting-types"
  );
  // The visibility rule is the real one; only the read is faked.
  return { listMeetingTypes: vi.fn(), visibleMeetingTypes: actual.visibleMeetingTypes };
});
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/calendar-tools/calendly", () => ({ pickCalendlyEventType: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  bookingLinkPromptLine,
  formatBookingLinkPromptLine,
  outreachSchedulingLink,
  publicBookingLink,
  schedulingLink
} from "@/lib/booking-page/prompt-line";
import { getBookingPageForBusiness, upsertBookingPage } from "@/lib/booking-page/db";
import { listMeetingTypes } from "@/lib/booking-page/meeting-types";
import { getBusiness } from "@/lib/db/businesses";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { pickCalendlyEventType } from "@/lib/calendar-tools/calendly";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockPage = vi.mocked(getBookingPageForBusiness);
const mockUpsert = vi.mocked(upsertBookingPage);
const mockBusiness = vi.mocked(getBusiness);
const mockConn = vi.mocked(resolveCalendarConnection);
const mockCalendly = vi.mocked(pickCalendlyEventType);
const mockTypes = vi.mocked(listMeetingTypes);

const PAGE = {
  enabled: true,
  slug: "new-coworker",
  token: "ncb_deadbeef"
};

/** Enough of a meeting for the label: name, and whether it is listed. */
function meeting(name: string, over: Record<string, unknown> = {}) {
  return {
    id: name,
    name,
    enabled: true,
    hidden: false,
    duration_minutes: 30,
    ...over
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.newcoworker.com/");
  mockPage.mockResolvedValue(PAGE as never);
  mockUpsert.mockResolvedValue(PAGE as never);
  mockBusiness.mockResolvedValue({ name: "New Coworker" } as never);
  mockTypes.mockResolvedValue([meeting("NC Discovery Call")]);
  // Default: a Google-connected tenant, which books through the native page.
  mockConn.mockResolvedValue({
    provider: "google",
    providerConfigKey: "google",
    connectionId: "c-1"
  });
  mockCalendly.mockResolvedValue("not_connected");
});

describe("publicBookingLink", () => {
  it("prefers the vanity slug and names the link by its one meeting", async () => {
    // One meeting IS the page, so the coworker can say what it books.
    expect(await publicBookingLink(BIZ)).toEqual({
      url: "https://www.newcoworker.com/book/new-coworker",
      title: "NC Discovery Call",
      meetings: [{ name: "NC Discovery Call", durationMinutes: 30 }]
    });
  });

  it("falls back to the token URL, and to the business name when the link opens a choice", async () => {
    mockPage.mockResolvedValue({ ...PAGE, slug: null } as never);
    mockTypes.mockResolvedValue([
      meeting("Discovery call", { duration_minutes: 60 }),
      meeting("Support call")
    ]);
    expect(await publicBookingLink(BIZ)).toEqual({
      url: "https://www.newcoworker.com/book/ncb_deadbeef",
      title: "Book a call with New Coworker",
      meetings: [
        { name: "Discovery call", durationMinutes: 60 },
        { name: "Support call", durationMinutes: 30 }
      ]
    });

    // A missing business still answers, with nothing to name it after.
    mockBusiness.mockResolvedValue(null as never);
    expect((await publicBookingLink(BIZ))?.title).toBe("Book a call with us");
  });

  it("offers only the meetings a visitor can actually see", async () => {
    mockTypes.mockResolvedValue([
      meeting("Discovery call"),
      meeting("Secret call", { hidden: true }),
      meeting("Paused call", { enabled: false })
    ]);
    // An unlisted or paused meeting is not a choice the link offers, so one
    // visible meeting still names the link outright.
    expect(await publicBookingLink(BIZ)).toMatchObject({
      title: "Discovery call",
      meetings: [{ name: "Discovery call", durationMinutes: 30 }]
    });
  });

  it("falls back to localhost when the app origin is unset (dev)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect((await publicBookingLink(BIZ))?.url).toBe("http://localhost:3000/book/new-coworker");
  });

  it("answers null with no page or a disabled one, and does not provision by default", async () => {
    mockPage.mockResolvedValue(null as never);
    expect(await publicBookingLink(BIZ)).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();

    mockPage.mockResolvedValue({ ...PAGE, enabled: false } as never);
    expect(await publicBookingLink(BIZ)).toBeNull();
  });
});

describe("schedulingLink (provider resolution)", () => {
  it("Calendly wins over the native page, picking a discovery-call-shaped event type", async () => {
    mockConn.mockResolvedValue({
      provider: "calendly",
      providerConfigKey: "calendly",
      connectionId: "c-2"
    });
    mockCalendly.mockResolvedValue({
      eventType: {
        uri: "u",
        name: "KYP Intro Call",
        duration: 30,
        schedulingUrl: "https://calendly.com/kyp/intro"
      }
    });
    expect(await schedulingLink(BIZ)).toEqual({
      url: "https://calendly.com/kyp/intro",
      title: "KYP Intro Call",
      meetings: [{ name: "KYP Intro Call", durationMinutes: 30 }],
      kind: "calendly"
    });
    expect(mockCalendly).toHaveBeenCalledWith(BIZ, expect.anything(), 30);
    // The native page is not even read for a Calendly tenant.
    expect(mockPage).not.toHaveBeenCalled();
  });

  it("a Calendly tenant with no readable link gets silence, never the native page", async () => {
    mockConn.mockResolvedValue({
      provider: "calendly",
      providerConfigKey: "calendly",
      connectionId: "c-2"
    });
    for (const answer of [
      "not_connected",
      "no_event_types",
      { eventType: { uri: "u", name: "x", duration: 30, schedulingUrl: null } }
    ] as const) {
      mockCalendly.mockResolvedValue(answer as never);
      expect(await schedulingLink(BIZ)).toBeNull();
    }
  });

  it("a Vagaro tenant gets no link: theirs lives on Vagaro's site, which we do not hold", async () => {
    mockConn.mockResolvedValue({
      provider: "vagaro",
      providerConfigKey: "vagaro",
      connectionId: "c-3"
    });
    expect(await schedulingLink(BIZ)).toBeNull();
    expect(mockPage).not.toHaveBeenCalled();
  });

  it("provisions the page on first need when the owner never opened Bookings", async () => {
    // A tenant delegating scheduling before ever visiting the dashboard
    // must not lose the link to a visit they never made. Same rule as the
    // dashboard's first view: created enabled, token unguessable.
    mockPage.mockResolvedValue(null as never);
    mockUpsert.mockResolvedValue(PAGE as never);
    expect(await schedulingLink(BIZ)).toEqual({
      url: "https://www.newcoworker.com/book/new-coworker",
      title: "NC Discovery Call",
      meetings: [{ name: "NC Discovery Call", durationMinutes: 30 }],
      kind: "booking_page"
    });
    expect(mockUpsert).toHaveBeenCalledWith(BIZ, { enabled: true });
  });

  it("a DISABLED page is the owner's off switch: no link, and no re-provisioning", async () => {
    mockPage.mockResolvedValue({ ...PAGE, enabled: false } as never);
    expect(await schedulingLink(BIZ)).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("loses the provisioning race gracefully: the winner's row serves the link", async () => {
    mockPage
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(PAGE as never);
    mockUpsert.mockRejectedValue(new Error("duplicate key uq_booking_pages_business"));
    expect((await schedulingLink(BIZ))?.url).toBe(
      "https://www.newcoworker.com/book/new-coworker"
    );

    // A failed provision with genuinely no page surfaces to the caller,
    // where bookingLinkPromptLine turns it into a missing hint.
    mockPage.mockReset();
    mockPage.mockResolvedValue(null as never);
    mockUpsert.mockRejectedValue(new Error("insert denied"));
    await expect(schedulingLink(BIZ)).rejects.toThrow("insert denied");
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();
  });

  it("never provisions for a Calendly or Vagaro tenant (their book lives elsewhere)", async () => {
    mockPage.mockResolvedValue(null as never);
    mockConn.mockResolvedValue({
      provider: "calendly",
      providerConfigKey: "calendly",
      connectionId: "c-2"
    });
    mockCalendly.mockResolvedValue("no_event_types");
    expect(await schedulingLink(BIZ)).toBeNull();

    mockConn.mockResolvedValue({
      provider: "vagaro",
      providerConfigKey: "vagaro",
      connectionId: "c-3"
    });
    expect(await schedulingLink(BIZ)).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("Google, CalDAV, and platform-mode tenants get the native page", async () => {
    expect((await schedulingLink(BIZ))?.kind).toBe("booking_page");

    mockConn.mockResolvedValue(null);
    expect((await schedulingLink(BIZ))?.kind).toBe("booking_page");

    mockConn.mockResolvedValue({
      provider: "caldav",
      providerConfigKey: "caldav",
      connectionId: "c-4"
    });
    expect((await schedulingLink(BIZ))?.kind).toBe("booking_page");
  });
});

describe("bookingLinkPromptLine", () => {
  it("names the exact URL and what it books, sends by default, forbids inventing another", async () => {
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain("https://www.newcoworker.com/book/new-coworker");
    expect(line).toContain('which books "NC Discovery Call" and runs 30 minutes');
    expect(line).toContain("Never invent a different booking URL");
    // The link is the DEFAULT for a delegation, not a menu option to offer
    // back to the owner; listed times only on an explicit ask, and an
    // address-supplied delegation is itself the send instruction.
    expect(line).toContain("Do NOT ask the owner whether");
    expect(line).toContain("explicitly asked for times");
    expect(line).toContain("that request IS the instruction to send the email");
    expect(line).toBe(
      formatBookingLinkPromptLine({
        url: "https://www.newcoworker.com/book/new-coworker",
        title: "NC Discovery Call",
        meetings: [{ name: "NC Discovery Call", durationMinutes: 30 }],
        kind: "booking_page"
      })
    );
  });

  // Jul 30 2026: HQ advertised a "15-minute discovery call" for a meeting
  // configured at 60, while an AI-made booking (which carries no meeting
  // type) silently used the tool's 30-minute default. The model can only know
  // the real length if this line states it.
  it("states each meeting's length and tells the model to book and quote exactly that", async () => {
    mockTypes.mockResolvedValue([meeting("Discovery Call", { duration_minutes: 60 })]);
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain("runs 60 minutes");
    expect(line).toContain("use that meeting's stated length as the appointment duration");
    expect(line).toContain("never describe it as shorter than it is");
  });

  it("omits the duration rule when there is no meeting to state a length for", async () => {
    mockTypes.mockResolvedValue([]);
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain("where the visitor picks a time");
    expect(line).not.toContain("stated length");
  });

  it("carries the Calendly event type's own duration", async () => {
    mockConn.mockResolvedValue({
      provider: "calendly",
      providerConfigKey: "calendly",
      connectionId: "c-2"
    });
    mockCalendly.mockResolvedValue({
      eventType: {
        uri: "u",
        name: "KYP Intro Call",
        duration: 45,
        schedulingUrl: "https://calendly.com/kyp/intro"
      }
    });
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain('"KYP Intro Call" and runs 45 minutes');
    expect(line).toContain("use that meeting's stated length");
  });

  it("names a Calendly event with no length rather than inventing one", () => {
    // Defensive: schedulingLink always supplies the event type's duration, but
    // this function is exported and pure. Saying nothing beats stating a
    // number nobody configured.
    const line = formatBookingLinkPromptLine({
      url: "https://calendly.com/kyp/intro",
      title: "KYP Intro Call",
      meetings: [],
      kind: "calendly"
    });
    expect(line).toContain('the event is called "KYP Intro Call").');
    expect(line).not.toContain("minutes");
    expect(line).not.toContain("stated length");
  });

  it("lists the meetings when the link opens a choice, and stays vague with none", async () => {
    mockTypes.mockResolvedValue([
      meeting("Discovery call", { duration_minutes: 60 }),
      meeting("Support call")
    ]);
    const many = await bookingLinkPromptLine(BIZ);
    expect(many).toContain(
      "chooses one of these meetings and then a time: Discovery call (60 minutes), Support call (30 minutes)"
    );

    // No meeting to name: the link still works, so the hint stays, minus
    // any claim about what it books.
    mockTypes.mockResolvedValue([]);
    const none = await bookingLinkPromptLine(BIZ);
    expect(none).toContain("where the visitor picks a time");
    expect(none).not.toContain("which books");
  });

  it("a Calendly tenant's line carries their Calendly event link", async () => {
    mockConn.mockResolvedValue({
      provider: "calendly",
      providerConfigKey: "calendly",
      connectionId: "c-2"
    });
    mockCalendly.mockResolvedValue({
      eventType: {
        uri: "https://api.calendly.com/event_types/abc",
        name: "KYP Intro Call",
        duration: 30,
        schedulingUrl: "https://calendly.com/kyp/intro"
      }
    });
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain("schedules through Calendly: https://calendly.com/kyp/intro");
    expect(line).toContain('"KYP Intro Call"');
  });

  it("a missing page provisions rather than staying silent; silence is the off switch or a failure", async () => {
    // No row: provisioned on first need, so the hint exists immediately.
    mockPage.mockResolvedValue(null as never);
    expect(await bookingLinkPromptLine(BIZ)).toContain("/book/new-coworker");
    expect(mockUpsert).toHaveBeenCalledWith(BIZ, { enabled: true });

    // Disabled row: the owner's off switch, no line and no re-provision.
    mockUpsert.mockClear();
    mockPage.mockResolvedValue({ ...PAGE, enabled: false } as never);
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();

    // A failed read costs only the hint.
    mockPage.mockRejectedValue(new Error("rls"));
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    mockPage.mockRejectedValue("string blast");
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();
  });
});

describe("outreachSchedulingLink (a cold email names the meeting)", () => {
  const DISCOVERY = meeting("Discovery Call", {
    id: "m-discovery",
    slug: "discovery-call",
    duration_minutes: 60
  });
  const SUPPORT = meeting("Support Call", { id: "m-support", slug: "support-call" });

  it("links straight to the chosen meeting instead of the chooser page", async () => {
    // The page's chooser asks "what would you like to book?", which is a fair
    // question for someone who arrived on purpose and a bad one for a stranger
    // who has read one paragraph about missed calls.
    mockTypes.mockResolvedValue([DISCOVERY, SUPPORT]);
    expect(await outreachSchedulingLink(BIZ, "m-discovery")).toEqual({
      url: "https://www.newcoworker.com/book/new-coworker/discovery-call",
      title: "Discovery Call",
      meetings: [{ name: "Discovery Call", durationMinutes: 60 }],
      kind: "booking_page"
    });
  });

  it("falls back to the page rather than a dead link, in every way it can come apart", async () => {
    // A cold email carrying the chooser link is worse than one naming a
    // meeting. A cold email carrying a link that says "not available" is worse
    // than both, so every one of these degrades to the page.
    mockTypes.mockResolvedValue([DISCOVERY, SUPPORT]);
    const page = await schedulingLink(BIZ);

    // No choice made: the behavior every existing tenant keeps.
    expect(await outreachSchedulingLink(BIZ, null)).toEqual(page);
    // Chosen, then deleted in Bookings.
    expect(await outreachSchedulingLink(BIZ, "m-gone")).toEqual(page);
    // Chosen, then switched off. Re-checked here rather than trusted from the
    // stored id, because a direct link to a disabled type fails closed.
    // Compared against the page link as it stands NOW, not the snapshot above:
    // disabling a meeting also changes what the page itself offers, and the
    // fallback is "whatever the page link is", not "whatever it used to be".
    mockTypes.mockResolvedValue([
      meeting("Discovery Call", {
        id: "m-discovery",
        slug: "discovery-call",
        duration_minutes: 60,
        enabled: false
      }),
      SUPPORT
    ]);
    expect(await outreachSchedulingLink(BIZ, "m-discovery")).toEqual(await schedulingLink(BIZ));
  });

  it("leaves a Calendly tenant's URL alone, and stays null when there is no link at all", async () => {
    // Calendly event types are not ours to deep link, and the URL it hands
    // back is already one specific event.
    mockConn.mockResolvedValue({ provider: "calendly" } as never);
    mockCalendly.mockResolvedValue({
      eventType: {
        schedulingUrl: "https://calendly.com/nc/intro",
        name: "Intro",
        duration: 30
      }
    } as never);
    mockTypes.mockResolvedValue([DISCOVERY]);
    expect(await outreachSchedulingLink(BIZ, "m-discovery")).toMatchObject({
      url: "https://calendly.com/nc/intro",
      kind: "calendly"
    });

    // Vagaro: no link is held at all, and no link beats an invented one.
    mockConn.mockResolvedValue({ provider: "vagaro" } as never);
    expect(await outreachSchedulingLink(BIZ, "m-discovery")).toBeNull();
  });
});
