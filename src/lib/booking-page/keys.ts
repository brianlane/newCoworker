/**
 * Capability-token format for the public self-serve booking page.
 *
 * `ncb_<64 hex>` — one token per business, stored in plaintext on
 * `booking_pages.token` (the value ships inside links the owner hands
 * out, so it is public by design, mirroring the webchat site key). It
 * grants nothing beyond "list coarse slot starts and submit one booking
 * request for this business"; rate limits and the submit-time slot
 * re-verify are the real controls.
 */

import { randomBytes } from "crypto";

export const BOOKING_PAGE_TOKEN_PREFIX = "ncb_";

export const BOOKING_PAGE_TOKEN_REGEX = /^ncb_[0-9a-f]{64}$/;

export function mintBookingPageToken(): string {
  return `${BOOKING_PAGE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/**
 * Extract a syntactically valid booking-page token from a request value
 * (path segment or JSON field). Null for anything else so callers can
 * fail closed without a DB round-trip on garbage.
 */
export function parseBookingPageToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return BOOKING_PAGE_TOKEN_REGEX.test(trimmed) ? trimmed : null;
}
