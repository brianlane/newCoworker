/**
 * The coworker's knowledge of its own booking link: vanity slug over raw
 * token, the same title fallback the public page renders, silence when
 * there is no enabled page, and a read failure that costs only the hint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({
  getBookingPageForBusiness: vi.fn(),
  upsertBookingPage: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveCalendarConnection: vi.fn() }));
vi.mock("@/lib/calendar-tools/calendly", () => ({ pickCalendlyEventType: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  bookingLinkPromptLine,
  formatBookingLinkPromptLine,
  publicBookingLink,
  schedulingLink
} from "@/lib/booking-page/prompt-line";
import { getBookingPageForBusiness, upsertBookingPage } from "@/lib/booking-page/db";
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

const PAGE = {
  enabled: true,
  slug: "new-coworker",
  token: "ncb_deadbeef",
  title: "NC Discovery Call"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.newcoworker.com/");
  mockPage.mockResolvedValue(PAGE as never);
  mockUpsert.mockResolvedValue(PAGE as never);
  mockBusiness.mockResolvedValue({ name: "New Coworker" } as never);
  // Default: a Google-connected tenant, which books through the native page.
  mockConn.mockResolvedValue({
    provider: "google",
    providerConfigKey: "google",
    connectionId: "c-1"
  });
  mockCalendly.mockResolvedValue("not_connected");
});

describe("publicBookingLink", () => {
  it("prefers the vanity slug and carries the owner's public title", async () => {
    expect(await publicBookingLink(BIZ)).toEqual({
      url: "https://www.newcoworker.com/book/new-coworker",
      title: "NC Discovery Call"
    });
  });

  it("falls back to the token URL and the default title, like the page itself", async () => {
    mockPage.mockResolvedValue({ ...PAGE, slug: null, title: null } as never);
    expect(await publicBookingLink(BIZ)).toEqual({
      url: "https://www.newcoworker.com/book/ncb_deadbeef",
      title: "Book a call with New Coworker"
    });

    // A blank title reads as unset, and a missing business still answers.
    mockPage.mockResolvedValue({ ...PAGE, title: "   " } as never);
    mockBusiness.mockResolvedValue(null as never);
    expect((await publicBookingLink(BIZ))?.title).toBe("Book a call with us");
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
  it("names the exact URL and title, sends by default, forbids inventing another", async () => {
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain("https://www.newcoworker.com/book/new-coworker");
    expect(line).toContain('"NC Discovery Call"');
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
        kind: "booking_page"
      })
    );
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
