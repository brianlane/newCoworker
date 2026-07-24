import { describe, expect, it } from "vitest";

import {
  BOOKING_PAGE_TOKEN_PREFIX,
  BOOKING_PAGE_TOKEN_REGEX,
  mintBookingPageToken,
  parseBookingPageRef,
  parseBookingPageSlug,
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

describe("booking-page slugs", () => {
  it("normalizes and accepts kebab slugs", () => {
    expect(parseBookingPageSlug(" New-Coworker ")).toBe("new-coworker");
    expect(parseBookingPageSlug("abc")).toBe("abc");
    expect(parseBookingPageSlug("a1-b2-c3")).toBe("a1-b2-c3");
  });

  it("rejects bad shapes, reserved names, and non-strings", () => {
    expect(parseBookingPageSlug("ab")).toBeNull(); // too short
    expect(parseBookingPageSlug("-abc")).toBeNull(); // edge hyphen
    expect(parseBookingPageSlug("abc-")).toBeNull();
    expect(parseBookingPageSlug("a_b_c")).toBeNull(); // underscores
    expect(parseBookingPageSlug("a".repeat(61))).toBeNull();
    expect(parseBookingPageSlug("api")).toBeNull(); // reserved
    expect(parseBookingPageSlug(7)).toBeNull();
  });
});

describe("parseBookingPageRef", () => {
  it("classifies tokens and slugs, rejecting everything else", () => {
    const token = mintBookingPageToken();
    expect(parseBookingPageRef(token)).toEqual({ kind: "token", value: token });
    expect(parseBookingPageRef("new-coworker")).toEqual({
      kind: "slug",
      value: "new-coworker"
    });
    expect(parseBookingPageRef("Not A Ref!")).toBeNull();
    expect(parseBookingPageRef(null)).toBeNull();
  });
});
