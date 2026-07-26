/**
 * The coworker's knowledge of its own booking link: vanity slug over raw
 * token, the same title fallback the public page renders, silence when
 * there is no enabled page, and a read failure that costs only the hint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-page/db", () => ({ getBookingPageForBusiness: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  bookingLinkPromptLine,
  formatBookingLinkPromptLine,
  publicBookingLink
} from "@/lib/booking-page/prompt-line";
import { getBookingPageForBusiness } from "@/lib/booking-page/db";
import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockPage = vi.mocked(getBookingPageForBusiness);
const mockBusiness = vi.mocked(getBusiness);

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
  mockBusiness.mockResolvedValue({ name: "New Coworker" } as never);
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

  it("answers null with no page or a disabled one", async () => {
    mockPage.mockResolvedValue(null as never);
    expect(await publicBookingLink(BIZ)).toBeNull();

    mockPage.mockResolvedValue({ ...PAGE, enabled: false } as never);
    expect(await publicBookingLink(BIZ)).toBeNull();
  });
});

describe("bookingLinkPromptLine", () => {
  it("names the exact URL and title, forbids inventing another, defers to explicit asks", async () => {
    const line = await bookingLinkPromptLine(BIZ);
    expect(line).toContain("https://www.newcoworker.com/book/new-coworker");
    expect(line).toContain('"NC Discovery Call"');
    expect(line).toContain("Never invent a different booking URL");
    // An owner who explicitly asked for listed times gets listed times.
    expect(line).toContain("If the owner explicitly asked");
    expect(line).toBe(
      formatBookingLinkPromptLine({
        url: "https://www.newcoworker.com/book/new-coworker",
        title: "NC Discovery Call"
      })
    );
  });

  it("is silent (null) without a page, and a failed read costs only the hint", async () => {
    mockPage.mockResolvedValue(null as never);
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();

    mockPage.mockRejectedValue(new Error("rls"));
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();

    mockPage.mockRejectedValue("string blast");
    expect(await bookingLinkPromptLine(BIZ)).toBeNull();
  });
});
