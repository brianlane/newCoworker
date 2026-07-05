import { describe, expect, it } from "vitest";
import { createHash } from "crypto";

import {
  API_KEY_PREFIX,
  API_KEY_REGEX,
  apiKeyFromAuthorizationHeader,
  hashApiKey,
  mintApiKey
} from "@/lib/public-api/keys";

describe("public API key format", () => {
  it("mints nck_-prefixed keys with 64 hex chars of entropy", () => {
    const minted = mintApiKey();
    expect(minted.plaintext).toMatch(API_KEY_REGEX);
    expect(minted.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(minted.prefix).toBe(minted.plaintext.slice(0, 12));
  });

  it("hash is the SHA-256 hex of the plaintext", () => {
    const minted = mintApiKey();
    const expected = createHash("sha256").update(minted.plaintext, "utf8").digest("hex");
    expect(minted.hash).toBe(expected);
    expect(hashApiKey(minted.plaintext)).toBe(expected);
  });

  it("mints unique keys", () => {
    expect(mintApiKey().plaintext).not.toBe(mintApiKey().plaintext);
  });
});

describe("apiKeyFromAuthorizationHeader", () => {
  const valid = `nck_${"a".repeat(64)}`;

  it("extracts a valid Bearer token (case-insensitive scheme)", () => {
    expect(apiKeyFromAuthorizationHeader(`Bearer ${valid}`)).toBe(valid);
    expect(apiKeyFromAuthorizationHeader(`bearer ${valid}`)).toBe(valid);
  });

  it("rejects missing header, wrong scheme, and malformed tokens", () => {
    expect(apiKeyFromAuthorizationHeader(null)).toBeNull();
    expect(apiKeyFromAuthorizationHeader("")).toBeNull();
    expect(apiKeyFromAuthorizationHeader(valid)).toBeNull();
    expect(apiKeyFromAuthorizationHeader(`Basic ${valid}`)).toBeNull();
    expect(apiKeyFromAuthorizationHeader("Bearer nck_short")).toBeNull();
    expect(apiKeyFromAuthorizationHeader(`Bearer sk_${"a".repeat(64)}`)).toBeNull();
    // Uppercase hex is out of format (we only mint lowercase).
    expect(apiKeyFromAuthorizationHeader(`Bearer nck_${"A".repeat(64)}`)).toBeNull();
  });
});
