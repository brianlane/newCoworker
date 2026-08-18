/**
 * The contact key: what identifies one row in `contacts`.
 *
 * `contacts.customer_e164` has never been "a phone number". It has always been
 * "the string that identifies this contact", and it already holds two shapes:
 *
 *   1. an E.164 number   `+16025551234`   (the overwhelming majority)
 *   2. a short code      `73339`          (lead sources text from these)
 *
 * This module adds a third and gives all three one vocabulary:
 *
 *   3. an email key      `email:val@example.com`
 *
 * Why a prefix instead of storing the bare address: every existing validator in
 * the codebase (CONTACT_NUMBER_RE, normalizeE164, normalizeDialableNumber) is a
 * digits-and-plus regex, so a prefixed key FAILS them. A phone-only code path
 * that has not been taught about email contacts therefore refuses the key
 * instead of quietly texting `val@example.com`. Fail closed, not open.
 *
 * The invariant, enforced in the database (contacts_email_key_matches_email):
 * a row keyed `email:<addr>` always carries `<addr>` in its `email` column, so
 * every existing email lookup (findCustomerByEmail, findContactsByEmails,
 * campaign audiences) sees these contacts without changing a single query.
 *
 * Lives in _shared because both sides need it: the Edge worker resolves contact
 * refs and files contacts, and the Next app creates and renders them. src
 * imports it the way capture-contact.ts already imports the flow engine.
 */

/** Marks a contact key whose identity is an email address, not a number. */
export const EMAIL_CONTACT_KEY_PREFIX = "email:";

/**
 * Pragmatic address shape, matching the five other EMAIL_RE copies in the repo
 * (booking-page, dashboard-chat, csv/employees, csv/contacts). Deliberately not
 * RFC 5322: real addresses are too varied to validate strictly, and the cost of
 * refusing a valid address is higher than the cost of storing an odd one.
 *
 * The extra refusals are the PostgREST filter metacharacters: comma, parens and
 * double quote. A key carrying one of those could change which rows an `.or()`
 * filter string matches, and both {@link contactAliasOrFilter} and the
 * duplicate-lead guard interpolate the value directly. Real addresses do not
 * use them (parens are RFC 5322 comment syntax and effectively never appear),
 * so refusing costs nothing and removes a whole class of escaping bug.
 */
const EMAIL_KEY_RE = /^[^\s@,()"]+@[^\s@,()"]+\.[^\s@,()"]+$/;

/** E.164, or a bare 3-8 digit short code. Mirrors CONTACT_NUMBER_RE in src. */
const NUMBER_KEY_RE = /^(\+[1-9]\d{6,15}|\d{3,8})$/;

export type ContactKeyKind = "phone" | "short_code" | "email";

/**
 * Build the canonical key for an email-identified contact, or null when the
 * address is unusable. Lowercased, so `Val@Example.com` and `val@example.com`
 * are the same contact rather than two.
 */
export function emailContactKey(email: string | null | undefined): string | null {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized || normalized.length > 254) return null;
  if (!EMAIL_KEY_RE.test(normalized)) return null;
  return `${EMAIL_CONTACT_KEY_PREFIX}${normalized}`;
}

/** True when this key identifies the contact by email address. */
export function isEmailContactKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(EMAIL_CONTACT_KEY_PREFIX);
}

/**
 * The address behind an email key, or null for a number key (or a malformed
 * `email:` string, which should be impossible past the DB constraint but is
 * cheap to refuse here too).
 */
export function contactKeyEmail(key: string | null | undefined): string | null {
  if (!isEmailContactKey(key)) return null;
  const addr = (key as string).slice(EMAIL_CONTACT_KEY_PREFIX.length).trim().toLowerCase();
  return EMAIL_KEY_RE.test(addr) ? addr : null;
}

/** Which of the three shapes this key is, or null when it is none of them. */
export function classifyContactKey(key: string | null | undefined): ContactKeyKind | null {
  const trimmed = (key ?? "").trim();
  if (!trimmed) return null;
  if (isEmailContactKey(trimmed)) return contactKeyEmail(trimmed) ? "email" : null;
  if (!NUMBER_KEY_RE.test(trimmed)) return null;
  return trimmed.startsWith("+") ? "phone" : "short_code";
}

/**
 * Can we send a text to / place a call to this key? Only a real E.164 number.
 *
 * Short codes have always been undialable (they text US, we cannot text back)
 * and email keys obviously are. Every send path that starts from a contact ROW
 * rather than from a live inbound message must gate on this.
 */
export function isDialableContactKey(key: string | null | undefined): boolean {
  return classifyContactKey(key) === "phone";
}

/**
 * How to show the key to a human: the bare address for an email contact, the
 * key itself otherwise. Callers still prefer `display_name` when one is set;
 * this is the fallback that used to be the raw column value.
 */
export function formatContactKey(key: string | null | undefined): string {
  return contactKeyEmail(key) ?? (key ?? "").trim();
}

/**
 * The PostgREST filter that matches a contact by its key OR by a merge alias,
 * or null when the key must be matched with a plain `.eq()` instead.
 *
 * Number keys are `+` and digits, so they are safe to interpolate into the
 * comma-delimited `.or()` string. Email keys are not worth the escaping risk
 * (an unescaped comma or paren silently changes which rows match), and they
 * gain nothing from the alias arm: `alias_e164s` only ever collects the numbers
 * a merge folded away. So callers use `.eq("customer_e164", key)` for those.
 */
export function contactAliasOrFilter(key: string): string | null {
  if (classifyContactKey(key) === "email") return null;
  return `customer_e164.eq.${key},alias_e164s.cs.{${key}}`;
}

/**
 * Is this address safe to interpolate into a PostgREST filter string?
 *
 * True exactly when {@link emailContactKey} would accept it, which is the
 * point: every address that becomes a contact key has already been through
 * that gate, and a caller building a filter from a RAW address (the
 * duplicate-lead guard matches on the flow's email var) gets the same
 * guarantee without having to know the rule.
 */
export function isFilterSafeEmail(email: string | null | undefined): boolean {
  return emailContactKey(email) !== null;
}
