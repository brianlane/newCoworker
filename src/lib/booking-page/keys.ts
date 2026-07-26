/**
 * Capability-token format for the public self-serve booking page.
 *
 * `ncb_<64 hex>`, one token per business, stored in plaintext on
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

/**
 * Per-BOOKING capability token behind /book/manage/<token>: "see, move, or
 * cancel this one appointment". Deliberately a different prefix from the
 * page token so a leaked manage link can never be mistaken for (or used
 * as) the business's booking page, and vice versa.
 */
export const BOOKING_MANAGE_TOKEN_PREFIX = "ncbm_";

export const BOOKING_MANAGE_TOKEN_REGEX = /^ncbm_[0-9a-f]{64}$/;

export function mintBookingManageToken(): string {
  return `${BOOKING_MANAGE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/** Valid manage token from a path segment, else null (fail closed, no DB hit). */
export function parseBookingManageToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return BOOKING_MANAGE_TOKEN_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * Vanity-slug shape for the friendly /book/<slug> URL: lowercase kebab,
 * 3-60 chars, letter/digit at both ends. Deliberately disjoint from the
 * token shape (no underscores), so one route segment resolves both.
 */
export const BOOKING_PAGE_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

/** Platform path segments a tenant slug must never shadow. */
export const RESERVED_BOOKING_SLUGS = new Set([
  "api",
  "book",
  "admin",
  "dashboard",
  "new",
  "www",
  // /book/manage/<token> is the invitee's self-serve route family; a tenant
  // page at /book/manage would sit confusingly next to it.
  "manage"
]);

/** Normalize owner input to a valid slug, or null when unusable. */
export function parseBookingPageSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  if (!BOOKING_PAGE_SLUG_REGEX.test(slug)) return null;
  if (RESERVED_BOOKING_SLUGS.has(slug)) return null;
  return slug;
}

export type BookingPageRef =
  | { kind: "token"; value: string }
  | { kind: "slug"; value: string };

/**
 * Classify a public /book/<ref> path segment: capability token or vanity
 * slug. Null for anything else so routes 404 without a DB round-trip.
 */
export function parseBookingPageRef(value: unknown): BookingPageRef | null {
  const token = parseBookingPageToken(value);
  if (token) return { kind: "token", value: token };
  const slug = parseBookingPageSlug(value);
  if (slug) return { kind: "slug", value: slug };
  return null;
}
