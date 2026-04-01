import { beforeEach, describe, expect, it, vi } from "vitest";

describe("onboarding token", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ONBOARDING_TOKEN_SECRET = "test-onboarding-secret";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("creates and verifies a token for the expected business id", async () => {
    const { createOnboardingToken, verifyOnboardingToken } = await import("@/lib/onboarding/token");

    const token = createOnboardingToken({ businessId: "biz_123" });

    expect(verifyOnboardingToken(token, { businessId: "biz_123" })).toBe(true);
    expect(verifyOnboardingToken(token, { businessId: "biz_other" })).toBe(false);
  });

  it("rejects malformed tokens", async () => {
    const { verifyOnboardingToken } = await import("@/lib/onboarding/token");

    expect(verifyOnboardingToken("not-a-token", { businessId: "biz_123" })).toBe(false);
    expect(verifyOnboardingToken("abc.def.ghi", { businessId: "biz_123" })).toBe(false);
  });

  it("rejects tokens with a valid signature but invalid payload json", async () => {
    const crypto = await import("crypto");
    const encodedPayload = Buffer.from("{bad json", "utf8").toString("base64url");
    const signature = crypto.createHmac("sha256", process.env.ONBOARDING_TOKEN_SECRET!).update(encodedPayload).digest("base64url");
    const { verifyOnboardingToken } = await import("@/lib/onboarding/token");

    expect(verifyOnboardingToken(`${encodedPayload}.${signature}`, { businessId: "biz_123" })).toBe(false);
  });

  it("uses SUPABASE_SERVICE_ROLE_KEY as a fallback secret", async () => {
    delete process.env.ONBOARDING_TOKEN_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fallback-secret";

    const { createOnboardingToken, verifyOnboardingToken } = await import("@/lib/onboarding/token");
    const token = createOnboardingToken({ businessId: "biz_fallback" });

    expect(verifyOnboardingToken(token, { businessId: "biz_fallback" })).toBe(true);
  });

  it("throws when no onboarding token secret source is configured", async () => {
    delete process.env.ONBOARDING_TOKEN_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { createOnboardingToken } = await import("@/lib/onboarding/token");

    expect(() => createOnboardingToken({ businessId: "biz_missing_secret" })).toThrow(
      "ONBOARDING_TOKEN_SECRET is not configured"
    );
  });

  it("creates the expected pending owner email", async () => {
    const { createPendingOwnerEmail } = await import("@/lib/onboarding/token");

    expect(createPendingOwnerEmail("biz_123")).toBe("pending+biz_123@onboarding.local");
  });
});
