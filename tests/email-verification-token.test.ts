import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("email verification token", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET = "test-email-verification-secret";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates and verifies a token, surfacing the email + issuedAt", async () => {
    const { createEmailVerificationToken, verifyEmailVerificationToken } = await import(
      "@/lib/email/verification-token"
    );

    const token = createEmailVerificationToken("Owner@Example.com", 1_700_000_000_000);
    const result = verifyEmailVerificationToken(token, 1_700_000_000_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.email).toBe("owner@example.com");
      expect(result.issuedAt).toBe(1_700_000_000_000);
    }
  });

  it("normalizes the embedded email to lowercase + trimmed", async () => {
    const { createEmailVerificationToken, verifyEmailVerificationToken } = await import(
      "@/lib/email/verification-token"
    );

    const token = createEmailVerificationToken("  Mixed@Case.COM  ");
    const result = verifyEmailVerificationToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.email).toBe("mixed@case.com");
  });

  it("rejects malformed tokens with `malformed`", async () => {
    const { verifyEmailVerificationToken } = await import("@/lib/email/verification-token");

    expect(verifyEmailVerificationToken("not-a-token")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyEmailVerificationToken("abc.def.ghi")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyEmailVerificationToken("abc.")).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects tampered signatures with `signature_mismatch`", async () => {
    const { createEmailVerificationToken, verifyEmailVerificationToken } = await import(
      "@/lib/email/verification-token"
    );
    const token = createEmailVerificationToken("victim@example.com");
    const [encoded] = token.split(".");
    const forged = `${encoded}.${"a".repeat(43)}`;

    expect(verifyEmailVerificationToken(forged)).toEqual({
      ok: false,
      reason: "signature_mismatch"
    });
  });

  it("rejects multi-byte signatures without throwing", async () => {
    const { createEmailVerificationToken, verifyEmailVerificationToken } = await import(
      "@/lib/email/verification-token"
    );
    const token = createEmailVerificationToken("multibyte@example.com");
    const [encoded] = token.split(".");

    expect(verifyEmailVerificationToken(`${encoded}.${"é".repeat(43)}`)).toEqual({
      ok: false,
      reason: "signature_mismatch"
    });
  });

  it("rejects tokens older than the 7-day TTL with `expired`", async () => {
    const { createEmailVerificationToken, verifyEmailVerificationToken } = await import(
      "@/lib/email/verification-token"
    );

    const issuedAt = 1_700_000_000_000;
    const token = createEmailVerificationToken("aged@example.com", issuedAt);

    const eightDaysLater = issuedAt + 8 * 24 * 60 * 60 * 1000;
    expect(verifyEmailVerificationToken(token, eightDaysLater)).toEqual({
      ok: false,
      reason: "expired"
    });

    const sixDaysLater = issuedAt + 6 * 24 * 60 * 60 * 1000;
    const within = verifyEmailVerificationToken(token, sixDaysLater);
    expect(within.ok).toBe(true);
  });

  it("rejects tokens with a valid signature but invalid payload json with `decode_error`", async () => {
    const crypto = await import("crypto");
    const encodedPayload = Buffer.from("{bad json", "utf8").toString("base64url");
    const signature = crypto
      .createHmac("sha256", process.env.EMAIL_VERIFICATION_TOKEN_SECRET!)
      .update(encodedPayload)
      .digest("base64url");

    const { verifyEmailVerificationToken } = await import("@/lib/email/verification-token");
    expect(verifyEmailVerificationToken(`${encodedPayload}.${signature}`)).toEqual({
      ok: false,
      reason: "decode_error"
    });
  });

  it("rejects tokens with valid signature but missing email with `decode_error`", async () => {
    const crypto = await import("crypto");
    const encodedPayload = Buffer.from(JSON.stringify({ issuedAt: Date.now() }), "utf8").toString(
      "base64url"
    );
    const signature = crypto
      .createHmac("sha256", process.env.EMAIL_VERIFICATION_TOKEN_SECRET!)
      .update(encodedPayload)
      .digest("base64url");

    const { verifyEmailVerificationToken } = await import("@/lib/email/verification-token");
    expect(verifyEmailVerificationToken(`${encodedPayload}.${signature}`)).toEqual({
      ok: false,
      reason: "decode_error"
    });
  });

  it("uses SUPABASE_SERVICE_ROLE_KEY as a fallback secret", async () => {
    delete process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fallback-secret";

    const { createEmailVerificationToken, verifyEmailVerificationToken } = await import(
      "@/lib/email/verification-token"
    );
    const token = createEmailVerificationToken("fallback@example.com");
    const result = verifyEmailVerificationToken(token);

    expect(result.ok).toBe(true);
  });

  it("throws when no token secret source is configured", async () => {
    delete process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { createEmailVerificationToken } = await import("@/lib/email/verification-token");
    expect(() => createEmailVerificationToken("nobody@example.com")).toThrow(
      "EMAIL_VERIFICATION_TOKEN_SECRET is not configured"
    );
  });
});
