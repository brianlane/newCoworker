import { describe, expect, it, vi } from "vitest";
import {
  describeMfaLoadFailure,
  listMfaFactorsWithRetry,
  splitTotpFactors,
  type ListFactorsOutcome,
  type MfaFactorSummary
} from "@/lib/auth/mfa-factor-load";

// Asserted as literals on purpose: three attempts, with 400ms then 800ms
// between them. A silent widening of the budget would stall the admin MFA
// page, so the numbers are part of the contract, not an implementation detail.
const ATTEMPTS = 3;
const FIRST_GAP_MS = 400;
const SECOND_GAP_MS = 800;

const VERIFIED: MfaFactorSummary = {
  id: "verified-totp",
  factor_type: "totp",
  status: "verified",
  friendly_name: "Admin authenticator"
};
const UNVERIFIED: MfaFactorSummary = {
  id: "half-finished-totp",
  factor_type: "totp",
  status: "unverified"
};
const PHONE: MfaFactorSummary = {
  id: "phone",
  factor_type: "phone",
  status: "verified"
};

function ok(all: MfaFactorSummary[]): ListFactorsOutcome {
  return { data: { all }, error: null };
}

describe("describeMfaLoadFailure", () => {
  it("keeps the underlying detail when there is one", () => {
    expect(describeMfaLoadFailure(new Error("Failed to fetch"))).toBe(
      "Could not load your authenticator from the auth service. Failed to fetch. Check your connection and try again."
    );
  });

  it("accepts a bare string reason", () => {
    expect(describeMfaLoadFailure("offline")).toContain("offline.");
  });

  // The bug this guards: an empty message renders as no error box at all, so
  // a page that loaded nothing looks like a page that loaded fine.
  it("still returns a sentence when the error message is empty", () => {
    expect(describeMfaLoadFailure(new Error("   "))).toBe(
      "Could not load your authenticator from the auth service. Check your connection and try again."
    );
  });

  it("still returns a sentence for a non-error, non-string throw", () => {
    expect(describeMfaLoadFailure({ weird: true })).toBe(
      "Could not load your authenticator from the auth service. Check your connection and try again."
    );
  });
});

describe("listMfaFactorsWithRetry", () => {
  it("returns the first successful answer without sleeping", async () => {
    const listFactors = vi.fn().mockResolvedValue(ok([VERIFIED]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await listMfaFactorsWithRetry(listFactors, sleep);

    expect(result).toEqual({ data: { all: [VERIFIED] }, error: null });
    expect(listFactors).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // An empty list is an answer, not a failure. Retrying it would delay the
  // enrollment QR code for an admin who genuinely has no factor yet.
  it("does not retry a successful empty result", async () => {
    const listFactors = vi.fn().mockResolvedValue(ok([]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await listMfaFactorsWithRetry(listFactors, sleep);

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ all: [] });
    expect(listFactors).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a returned error and widens the gap between attempts", async () => {
    const listFactors = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: new Error("boom") })
      .mockResolvedValueOnce(ok([VERIFIED]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await listMfaFactorsWithRetry(listFactors, sleep);

    expect(result.error).toBeNull();
    expect(listFactors).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(FIRST_GAP_MS);
  });

  it("retries a thrown transport failure", async () => {
    const listFactors = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(ok([VERIFIED]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await listMfaFactorsWithRetry(listFactors, sleep);

    expect(result.error).toBeNull();
    expect(listFactors).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and reports the last failure", async () => {
    const last = new Error("still down");
    const listFactors = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce({ data: null, error: new Error("second") })
      .mockRejectedValueOnce(last);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await listMfaFactorsWithRetry(listFactors, sleep);

    expect(result).toEqual({ data: null, error: last });
    expect(listFactors).toHaveBeenCalledTimes(ATTEMPTS);
    // One gap between attempts, never a trailing sleep after the last try.
    expect(sleep.mock.calls).toEqual([[FIRST_GAP_MS], [SECOND_GAP_MS]]);
  });

  it("falls back to a real timer when no sleep is injected", async () => {
    const listFactors = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: new Error("boom") })
      .mockResolvedValueOnce(ok([VERIFIED]));

    const result = await listMfaFactorsWithRetry(listFactors);

    expect(result.error).toBeNull();
    expect(listFactors).toHaveBeenCalledTimes(2);
  });
});

describe("splitTotpFactors", () => {
  // The regression: auth-js puts ONLY verified factors in `data.totp`, so the
  // old code read `totp` and could never see a half-finished enrollment.
  it("finds unverified TOTP factors that data.totp would have hidden", () => {
    const split = splitTotpFactors({ all: [VERIFIED, UNVERIFIED] });

    expect(split.totp).toEqual([VERIFIED, UNVERIFIED]);
    expect(split.verified).toEqual([VERIFIED]);
    expect(split.unverified).toEqual([UNVERIFIED]);
  });

  it("ignores factors that are not TOTP", () => {
    const split = splitTotpFactors({ all: [PHONE, VERIFIED] });

    expect(split.totp).toEqual([VERIFIED]);
    expect(split.verified).toEqual([VERIFIED]);
    expect(split.unverified).toEqual([]);
  });

  it("treats a null list as empty", () => {
    expect(splitTotpFactors(null)).toEqual({
      totp: [],
      verified: [],
      unverified: []
    });
  });

  it("treats a missing all array as empty", () => {
    expect(splitTotpFactors({})).toEqual({
      totp: [],
      verified: [],
      unverified: []
    });
  });
});
