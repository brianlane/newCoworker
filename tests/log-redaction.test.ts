import { describe, it, expect } from "vitest";
import {
  REDACTED,
  isSensitiveKey,
  redactContext,
  splitKeyWords
} from "@/lib/log-redaction";

describe("splitKeyWords", () => {
  it("splits camelCase", () => {
    expect(splitKeyWords("accessToken")).toEqual(["access", "token"]);
  });

  it("splits snake_case, kebab-case and spaces the same way", () => {
    expect(splitKeyWords("access_token")).toEqual(["access", "token"]);
    expect(splitKeyWords("ACCESS-TOKEN")).toEqual(["access", "token"]);
    expect(splitKeyWords("access token")).toEqual(["access", "token"]);
  });

  it("keeps digits with their word and drops empty segments", () => {
    expect(splitKeyWords("__sha256Hash__")).toEqual(["sha256", "hash"]);
  });

  it("returns an empty list for a key with no word characters", () => {
    expect(splitKeyWords("---")).toEqual([]);
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "password",
    "userPassword",
    "passwd",
    "passphrase",
    "clientSecret",
    "accessToken",
    "refresh_token",
    "authorization",
    "Cookie",
    "credential",
    "credentials",
    "cvv",
    "cvc",
    "ssn",
    "otp",
    "privateKey",
    "apiKey",
    "api_key",
    "accessKey",
    "secretKey",
    "cardNumber",
    "account_number"
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "idempotencyKey",
    "cacheKey",
    "authProvider",
    "businessId",
    "email",
    "durationMs",
    "keyboard"
  ])("leaves %s alone", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it("does not match a phrase whose words are separated", () => {
    expect(isSensitiveKey("apiRequestKey")).toBe(false);
  });
});

describe("redactContext", () => {
  it("redacts a top-level secret and keeps the rest", () => {
    expect(redactContext({ password: "hunter2", businessId: "biz_1" })).toEqual({
      password: REDACTED,
      businessId: "biz_1"
    });
  });

  it("redacts inside nested objects", () => {
    expect(redactContext({ user: { email: "a@b.com", accessToken: "tok" } })).toEqual({
      user: { email: "a@b.com", accessToken: REDACTED }
    });
  });

  it("redacts inside arrays", () => {
    expect(redactContext({ items: [{ apiKey: "k" }, { id: 2 }] })).toEqual({
      items: [{ apiKey: REDACTED }, { id: 2 }]
    });
  });

  it("passes primitives and null through untouched", () => {
    expect(redactContext({ a: 1, b: "s", c: true, d: null, e: undefined })).toEqual({
      a: 1,
      b: "s",
      c: true,
      d: null,
      e: undefined
    });
  });

  it("keeps name and message from an Error instead of the empty object JSON gives", () => {
    expect(redactContext({ error: new TypeError("boom") })).toEqual({
      error: { name: "TypeError", message: "boom" }
    });
  });

  it("marks a cycle rather than recursing forever", () => {
    const node: Record<string, unknown> = { id: 1 };
    node.self = node;
    expect(redactContext({ node })).toEqual({ node: { id: 1, self: "[circular]" } });
  });

  it("does not mistake a shared reference for a cycle", () => {
    const shared = { id: 7 };
    expect(redactContext({ a: shared, b: shared })).toEqual({
      a: { id: 7 },
      b: { id: 7 }
    });
  });

  it("stops at the depth cap", () => {
    // 9 levels of nesting: the innermost value sits past MAX_DEPTH.
    let deep: Record<string, unknown> = { bottom: "value" };
    for (let i = 0; i < 9; i++) deep = { nest: deep };

    const out = JSON.stringify(redactContext(deep));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("value");
  });

  it("never mutates the caller's object", () => {
    const input = { password: "hunter2", nested: { token: "t" } };
    redactContext(input);
    expect(input.password).toBe("hunter2");
    expect(input.nested.token).toBe("t");
  });

  it("produces output that survives JSON.stringify", () => {
    const node: Record<string, unknown> = { password: "p" };
    node.self = node;
    expect(() => JSON.stringify(redactContext({ node }))).not.toThrow();
  });
});
