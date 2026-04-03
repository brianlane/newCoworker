import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleOAuthStateToken,
  parseGoogleOAuthStateToken
} from "@/lib/integrations/google-oauth-state";

describe("google-oauth-state", () => {
  beforeEach(() => {
    vi.useRealTimers();
    process.env.GOOGLE_OAUTH_STATE_SECRET = "test-secret";
    delete process.env.ONBOARDING_TOKEN_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("round-trips a valid token", () => {
    const token = createGoogleOAuthStateToken({
      businessId: "biz-1",
      state: "abc123"
    });

    expect(parseGoogleOAuthStateToken(token)).toEqual({
      businessId: "biz-1",
      state: "abc123"
    });
  });

  it("rejects a tampered token", () => {
    const token = createGoogleOAuthStateToken({
      businessId: "biz-1",
      state: "abc123"
    });
    const [payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        businessId: "biz-2",
        state: "abc123",
        issuedAt: Date.now()
      })
    ).toString("base64url");

    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(parseGoogleOAuthStateToken(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("rejects tokens with the wrong part count", () => {
    expect(parseGoogleOAuthStateToken("only-one-part")).toBeNull();
  });

  it("rejects tokens with a missing signature", () => {
    expect(parseGoogleOAuthStateToken("payload.")).toBeNull();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T18:00:00Z"));

    const token = createGoogleOAuthStateToken({
      businessId: "biz-1",
      state: "abc123"
    });

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(parseGoogleOAuthStateToken(token)).toBeNull();
  });

  it("rejects a malformed payload", () => {
    const badPayload = Buffer.from("{not-json", "utf8").toString("base64url");
    const signature = createHmac("sha256", "test-secret").update(badPayload).digest("base64url");

    expect(parseGoogleOAuthStateToken(`${badPayload}.${signature}`)).toBeNull();
  });

  it("rejects payloads missing required fields", () => {
    const missingFieldsPayload = Buffer.from(
      JSON.stringify({
        businessId: "",
        state: "abc123",
        issuedAt: Date.now()
      }),
      "utf8"
    ).toString("base64url");
    const signature = createHmac("sha256", "test-secret")
      .update(missingFieldsPayload)
      .digest("base64url");

    expect(parseGoogleOAuthStateToken(`${missingFieldsPayload}.${signature}`)).toBeNull();
  });

  it("rejects payloads without a numeric issuedAt", () => {
    const badIssuedAtPayload = Buffer.from(
      JSON.stringify({
        businessId: "biz-1",
        state: "abc123",
        issuedAt: "not-a-number"
      }),
      "utf8"
    ).toString("base64url");
    const signature = createHmac("sha256", "test-secret")
      .update(badIssuedAtPayload)
      .digest("base64url");

    expect(parseGoogleOAuthStateToken(`${badIssuedAtPayload}.${signature}`)).toBeNull();
  });

  it("throws when no signing secret is configured", () => {
    delete process.env.GOOGLE_OAUTH_STATE_SECRET;
    delete process.env.ONBOARDING_TOKEN_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() =>
      createGoogleOAuthStateToken({
        businessId: "biz-1",
        state: "abc123"
      })
    ).toThrow("GOOGLE_OAUTH_STATE_SECRET is not configured");
  });
});
