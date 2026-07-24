import { describe, expect, it } from "vitest";

import {
  BOOKING_PAGE_TOKEN_PREFIX,
  BOOKING_PAGE_TOKEN_REGEX,
  mintBookingPageToken,
  parseBookingPageToken
} from "@/lib/booking-page/keys";

describe("booking-page keys", () => {
  it("mints ncb_ tokens that match the published format", () => {
    const token = mintBookingPageToken();
    expect(token.startsWith(BOOKING_PAGE_TOKEN_PREFIX)).toBe(true);
    expect(BOOKING_PAGE_TOKEN_REGEX.test(token)).toBe(true);
    // 256 bits of entropy: two mints never collide.
    expect(mintBookingPageToken()).not.toBe(token);
  });

  it("parses a valid token, tolerating surrounding whitespace", () => {
    const token = mintBookingPageToken();
    expect(parseBookingPageToken(token)).toBe(token);
    expect(parseBookingPageToken(`  ${token}\n`)).toBe(token);
  });

  it("rejects non-strings, wrong prefixes, wrong lengths, and uppercase hex", () => {
    expect(parseBookingPageToken(null)).toBeNull();
    expect(parseBookingPageToken(42)).toBeNull();
    expect(parseBookingPageToken("")).toBeNull();
    expect(parseBookingPageToken("ncw_pub_" + "a".repeat(64))).toBeNull();
    expect(parseBookingPageToken("ncb_" + "a".repeat(63))).toBeNull();
    expect(parseBookingPageToken("ncb_" + "A".repeat(64))).toBeNull();
  });
});
