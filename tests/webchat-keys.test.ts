import { describe, expect, it } from "vitest";
import {
  WIDGET_KEY_PREFIX,
  WIDGET_KEY_REGEX,
  WIDGET_SESSION_TOKEN_PREFIX,
  WIDGET_SESSION_TOKEN_REGEX,
  hashWebchatToken,
  mintWidgetKey,
  mintWebchatSessionToken,
  parseWidgetKey,
  sessionTokenFromAuthorizationHeader
} from "@/lib/webchat/keys";

describe("mintWidgetKey", () => {
  it("mints ncw_pub_ keys with a matching sha256", () => {
    const k = mintWidgetKey();
    expect(k.plaintext.startsWith(WIDGET_KEY_PREFIX)).toBe(true);
    expect(WIDGET_KEY_REGEX.test(k.plaintext)).toBe(true);
    expect(k.hash).toBe(hashWebchatToken(k.plaintext));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints unique keys", () => {
    expect(mintWidgetKey().plaintext).not.toBe(mintWidgetKey().plaintext);
  });
});

describe("mintWebchatSessionToken", () => {
  it("mints ncws_ bearers with a matching sha256", () => {
    const t = mintWebchatSessionToken();
    expect(t.plaintext.startsWith(WIDGET_SESSION_TOKEN_PREFIX)).toBe(true);
    expect(WIDGET_SESSION_TOKEN_REGEX.test(t.plaintext)).toBe(true);
    expect(t.hash).toBe(hashWebchatToken(t.plaintext));
  });
});

describe("parseWidgetKey", () => {
  const valid = `ncw_pub_${"a".repeat(64)}`;

  it("accepts a syntactically valid key (with surrounding whitespace)", () => {
    expect(parseWidgetKey(valid)).toBe(valid);
    expect(parseWidgetKey(`  ${valid}  `)).toBe(valid);
  });

  it("rejects non-strings, wrong prefixes, and wrong lengths", () => {
    expect(parseWidgetKey(undefined)).toBeNull();
    expect(parseWidgetKey(42)).toBeNull();
    expect(parseWidgetKey("")).toBeNull();
    expect(parseWidgetKey(`nck_${"a".repeat(64)}`)).toBeNull();
    expect(parseWidgetKey(`ncw_pub_${"a".repeat(63)}`)).toBeNull();
    expect(parseWidgetKey(`ncw_pub_${"A".repeat(64)}`)).toBeNull();
  });
});

describe("sessionTokenFromAuthorizationHeader", () => {
  const token = `ncws_${"b".repeat(64)}`;

  it("extracts a Bearer session token (case-insensitive scheme)", () => {
    expect(sessionTokenFromAuthorizationHeader(`Bearer ${token}`)).toBe(token);
    expect(sessionTokenFromAuthorizationHeader(`bearer ${token}`)).toBe(token);
  });

  it("rejects missing/garbage headers and non-session tokens", () => {
    expect(sessionTokenFromAuthorizationHeader(null)).toBeNull();
    expect(sessionTokenFromAuthorizationHeader("")).toBeNull();
    expect(sessionTokenFromAuthorizationHeader(token)).toBeNull();
    expect(sessionTokenFromAuthorizationHeader("Bearer")).toBeNull();
    expect(sessionTokenFromAuthorizationHeader("Bearer nope")).toBeNull();
    expect(
      sessionTokenFromAuthorizationHeader(`Bearer ncw_pub_${"a".repeat(64)}`)
    ).toBeNull();
  });
});
