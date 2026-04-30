import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB helper so we don't actually need a live supabase client.
// The action's job is to glue token-verification to the DB write; the
// DB write itself is exercised independently in
// tests/customer-profiles-email-verification.test.ts.
//
// `vi.hoisted` is required because `vi.mock` is hoisted above all
// imports — referencing a top-level `const fn = vi.fn()` would crash
// with a TDZ error. `vi.hoisted` lets us share a single mock instance
// between the module mock and the test bodies.
const { markEmailVerifiedByEmailMock } = vi.hoisted(() => ({
  markEmailVerifiedByEmailMock: vi.fn()
}));

vi.mock("@/lib/db/customer-profiles", () => ({
  markEmailVerifiedByEmail: markEmailVerifiedByEmailMock
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { confirmEmailVerificationAction } from "@/app/verify-email/actions";
import { createEmailVerificationToken } from "@/lib/email/verification-token";

function makeFormData(entries: Record<string, FormDataEntryValue> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("/verify-email confirm action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET = "verify-action-test-secret";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips email_verified_at on the first valid confirm", async () => {
    markEmailVerifiedByEmailMock.mockResolvedValueOnce({
      ok: true,
      alreadyVerified: false
    });
    const token = createEmailVerificationToken("Owner@Example.com");

    const result = await confirmEmailVerificationAction(null, makeFormData({ token }));

    expect(result).toEqual({ kind: "ok", alreadyVerified: false });
    expect(markEmailVerifiedByEmailMock).toHaveBeenCalledWith("owner@example.com");
  });

  it("returns alreadyVerified=true on idempotent replay (clicked twice / refreshed page)", async () => {
    markEmailVerifiedByEmailMock.mockResolvedValueOnce({
      ok: true,
      alreadyVerified: true
    });
    const token = createEmailVerificationToken("owner@example.com");

    const result = await confirmEmailVerificationAction(null, makeFormData({ token }));

    expect(result).toEqual({ kind: "ok", alreadyVerified: true });
  });

  it("returns missing_token when the form has no token field", async () => {
    const result = await confirmEmailVerificationAction(null, makeFormData());
    expect(result).toEqual({ kind: "error", reason: "missing_token" });
    expect(markEmailVerifiedByEmailMock).not.toHaveBeenCalled();
  });

  it("returns missing_token when the token field is an empty string", async () => {
    const result = await confirmEmailVerificationAction(null, makeFormData({ token: "" }));
    expect(result).toEqual({ kind: "error", reason: "missing_token" });
  });

  it("returns missing_token when the token field is a File (non-string)", async () => {
    // FormData accepts both strings and Files. Server actions must
    // refuse the File case so an attacker can't smuggle in a value
    // whose `.toString()` would coerce to "[object File]" and
    // subsequently fail signature_mismatch (still safe, but the
    // explicit narrow keeps us from logging confusing token values).
    const result = await confirmEmailVerificationAction(
      null,
      makeFormData({ token: new File(["x"], "x.txt") })
    );
    expect(result).toEqual({ kind: "error", reason: "missing_token" });
  });

  it("returns expired when the token is older than the 7-day TTL", async () => {
    const issuedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const token = createEmailVerificationToken("aged@example.com", issuedAt);

    const result = await confirmEmailVerificationAction(null, makeFormData({ token }));

    expect(result).toEqual({ kind: "error", reason: "expired" });
    expect(markEmailVerifiedByEmailMock).not.toHaveBeenCalled();
  });

  it("returns invalid when the token is structurally malformed", async () => {
    const result = await confirmEmailVerificationAction(
      null,
      makeFormData({ token: "not.a.token" })
    );
    expect(result).toEqual({ kind: "error", reason: "invalid" });
    expect(markEmailVerifiedByEmailMock).not.toHaveBeenCalled();
  });

  it("returns invalid when the signature is tampered", async () => {
    const token = createEmailVerificationToken("victim@example.com");
    const [encoded] = token.split(".");
    const tampered = `${encoded}.${"a".repeat(43)}`;

    const result = await confirmEmailVerificationAction(null, makeFormData({ token: tampered }));

    expect(result).toEqual({ kind: "error", reason: "invalid" });
  });

  it("returns not_found when the DB lookup misses", async () => {
    markEmailVerifiedByEmailMock.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const token = createEmailVerificationToken("ghost@example.com");

    const result = await confirmEmailVerificationAction(null, makeFormData({ token }));

    expect(result).toEqual({ kind: "error", reason: "not_found" });
  });

  it("returns internal when markEmailVerifiedByEmail throws", async () => {
    markEmailVerifiedByEmailMock.mockRejectedValueOnce(new Error("db down"));
    const token = createEmailVerificationToken("crash@example.com");

    const result = await confirmEmailVerificationAction(null, makeFormData({ token }));

    expect(result).toEqual({ kind: "error", reason: "internal" });
  });

  it("also returns internal when the underlying error is a non-Error throw", async () => {
    // The action stringifies non-Error throws ('reason: String(err)' branch).
    // Cover that path so both sides of the err-instanceof-Error guard
    // are exercised.
    markEmailVerifiedByEmailMock.mockRejectedValueOnce("string-thrown");
    const token = createEmailVerificationToken("string-throw@example.com");

    const result = await confirmEmailVerificationAction(null, makeFormData({ token }));

    expect(result).toEqual({ kind: "error", reason: "internal" });
  });
});
