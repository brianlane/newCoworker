import { describe, expect, it } from "vitest";

/**
 * Coverage for supabase/functions/_shared/contact_key.ts.
 *
 * `contacts.customer_e164` is the contact KEY, not a phone number: it holds an
 * E.164 number, a bare short code, or (new) an `email:` key for a contact we
 * only know by address. These assertions pin the two properties the rest of the
 * system leans on:
 *
 *   1. An email key is never mistaken for something dialable. Every send path
 *      that starts from a contact row gates on isDialableContactKey, so if this
 *      ever returned true for an `email:` key we would try to text an address.
 *   2. An email key never reaches a PostgREST `.or()` filter string, where an
 *      unescaped character would silently change which rows match.
 */

import {
  EMAIL_CONTACT_KEY_PREFIX,
  emailIlikePattern,
  isFilterSafeEmail,
  classifyContactKey,
  contactAliasOrFilter,
  contactKeyEmail,
  emailContactKey,
  formatContactKey,
  isDialableContactKey,
  isEmailContactKey
} from "../supabase/functions/_shared/contact_key";

const PHONE = "+16025551234";
const SHORT_CODE = "73339";
const ADDRESS = "valm0417@gmail.com";
const EMAIL_KEY = `${EMAIL_CONTACT_KEY_PREFIX}${ADDRESS}`;

describe("emailContactKey", () => {
  it("builds the prefixed key from a plain address", () => {
    expect(emailContactKey(ADDRESS)).toBe(EMAIL_KEY);
  });

  it("lowercases and trims, so one person is one contact whatever they typed", () => {
    expect(emailContactKey("  VaLM0417@Gmail.COM  ")).toBe(EMAIL_KEY);
  });

  it("refuses empty, null and undefined", () => {
    expect(emailContactKey("")).toBeNull();
    expect(emailContactKey("   ")).toBeNull();
    expect(emailContactKey(null)).toBeNull();
    expect(emailContactKey(undefined)).toBeNull();
  });

  it("refuses anything that is not shaped like an address", () => {
    expect(emailContactKey("not-an-address")).toBeNull();
    expect(emailContactKey("no@tld")).toBeNull();
    expect(emailContactKey("two parts@example.com")).toBeNull();
    expect(emailContactKey(PHONE)).toBeNull();
  });

  it("refuses every PostgREST filter metacharacter", () => {
    // These values are interpolated into `.or()` filter strings (the alias
    // match and the duplicate-lead guard), where any of them changes which
    // rows match. Real addresses never carry them.
    expect(emailContactKey("a,b@example.com")).toBeNull();
    expect(emailContactKey("a(b@example.com")).toBeNull();
    expect(emailContactKey("a)b@example.com")).toBeNull();
    expect(emailContactKey('a"b@example.com')).toBeNull();
  });

  it("refuses an address longer than the 254-char column limit", () => {
    expect(emailContactKey(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("isEmailContactKey", () => {
  it("is true only for the prefixed form", () => {
    expect(isEmailContactKey(EMAIL_KEY)).toBe(true);
    expect(isEmailContactKey(PHONE)).toBe(false);
    expect(isEmailContactKey(SHORT_CODE)).toBe(false);
    // A bare address is NOT a key: the prefix is what makes it unambiguous.
    expect(isEmailContactKey(ADDRESS)).toBe(false);
    expect(isEmailContactKey(null)).toBe(false);
    expect(isEmailContactKey(undefined)).toBe(false);
  });
});

describe("contactKeyEmail", () => {
  it("returns the address behind an email key", () => {
    expect(contactKeyEmail(EMAIL_KEY)).toBe(ADDRESS);
    expect(contactKeyEmail(`${EMAIL_CONTACT_KEY_PREFIX} VAL@Example.com `)).toBe(
      "val@example.com"
    );
  });

  it("returns null for a number key or a malformed email key", () => {
    expect(contactKeyEmail(PHONE)).toBeNull();
    expect(contactKeyEmail(null)).toBeNull();
    expect(contactKeyEmail(`${EMAIL_CONTACT_KEY_PREFIX}garbage`)).toBeNull();
  });
});

describe("classifyContactKey", () => {
  it("names each of the three shapes", () => {
    expect(classifyContactKey(PHONE)).toBe("phone");
    expect(classifyContactKey(SHORT_CODE)).toBe("short_code");
    expect(classifyContactKey(EMAIL_KEY)).toBe("email");
  });

  it("returns null for anything that is not a contact key", () => {
    expect(classifyContactKey("")).toBeNull();
    expect(classifyContactKey("   ")).toBeNull();
    expect(classifyContactKey(null)).toBeNull();
    expect(classifyContactKey(undefined)).toBeNull();
    // A bare 10-digit number is ambiguous, and always has been: callers
    // normalize to E.164 before they get here.
    expect(classifyContactKey("5551234567")).toBeNull();
    expect(classifyContactKey("amy")).toBeNull();
    expect(classifyContactKey(`${EMAIL_CONTACT_KEY_PREFIX}garbage`)).toBeNull();
  });
});

describe("isDialableContactKey", () => {
  it("is true for a real number and false for everything else", () => {
    expect(isDialableContactKey(PHONE)).toBe(true);
    // A short code texts US; we cannot text it back. Undialable since always.
    expect(isDialableContactKey(SHORT_CODE)).toBe(false);
    expect(isDialableContactKey(EMAIL_KEY)).toBe(false);
    expect(isDialableContactKey(null)).toBe(false);
  });
});

describe("formatContactKey", () => {
  it("shows an address without the internal prefix", () => {
    expect(formatContactKey(EMAIL_KEY)).toBe(ADDRESS);
  });

  it("shows a number key unchanged", () => {
    expect(formatContactKey(PHONE)).toBe(PHONE);
    expect(formatContactKey(SHORT_CODE)).toBe(SHORT_CODE);
  });

  it("degrades to the empty string rather than printing null", () => {
    expect(formatContactKey(null)).toBe("");
    expect(formatContactKey(undefined)).toBe("");
  });
});

describe("contactAliasOrFilter", () => {
  it("keeps the alias-aware filter for number keys", () => {
    expect(contactAliasOrFilter(PHONE)).toBe(
      `customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`
    );
    expect(contactAliasOrFilter(SHORT_CODE)).toBe(
      `customer_e164.eq.${SHORT_CODE},alias_e164s.cs.{${SHORT_CODE}}`
    );
  });

  it("returns null for an email key so the caller uses an exact match", () => {
    // This is the guard that keeps an address out of a comma-delimited filter
    // string. alias_e164s only ever holds NUMBERS a merge folded away, so the
    // alias arm could not have matched anyway.
    expect(contactAliasOrFilter(EMAIL_KEY)).toBeNull();
  });

  it("still builds a filter for an unrecognized key rather than silently matching nothing", () => {
    // Not a valid key, but the caller is asking how to match it; the exact-match
    // fallback is reserved for email keys specifically.
    expect(contactAliasOrFilter("amy")).toBe("customer_e164.eq.amy,alias_e164s.cs.{amy}");
  });
});

describe("isFilterSafeEmail", () => {
  it("accepts exactly what could become a key, so a raw-address caller gets the same guarantee", () => {
    expect(isFilterSafeEmail(ADDRESS)).toBe(true);
    expect(isFilterSafeEmail("a,b@example.com")).toBe(false);
    expect(isFilterSafeEmail("a(b@example.com")).toBe(false);
    expect(isFilterSafeEmail(null)).toBe(false);
  });
});

describe("emailIlikePattern", () => {
  it("escapes the LIKE wildcards so the match is literal", () => {
    // An underscore is common in a real local part. Unescaped, this pattern
    // would also match firstXlast@x.com and could suppress a DIFFERENT
    // person's outreach in the duplicate-lead guard.
    expect(emailIlikePattern("first_last@x.com")).toBe("first\\_last@x.com");
    expect(emailIlikePattern("a%b@x.com")).toBe("a\\%b@x.com");
    expect(emailIlikePattern("a\\b@x.com")).toBe("a\\\\b@x.com");
  });

  it("leaves an ordinary address untouched", () => {
    expect(emailIlikePattern(ADDRESS)).toBe(ADDRESS);
  });
});
