import { describe, it, expect } from "vitest";
import { isPasskeyCeremonyCancellation, passkeyErrorMessage } from "@/lib/auth/passkey-errors";

describe("isPasskeyCeremonyCancellation", () => {
  it("treats an aborted ceremony as a cancellation", () => {
    expect(isPasskeyCeremonyCancellation({ code: "ERROR_CEREMONY_ABORTED" })).toBe(true);
  });

  it("treats the raw browser abort errors as cancellations", () => {
    expect(isPasskeyCeremonyCancellation({ name: "AbortError" })).toBe(true);
    expect(isPasskeyCeremonyCancellation({ name: "NotAllowedError" })).toBe(true);
  });

  it("does not swallow real failures", () => {
    expect(isPasskeyCeremonyCancellation({ code: "ERROR_INVALID_RP_ID" })).toBe(false);
    expect(isPasskeyCeremonyCancellation({ name: "SecurityError" })).toBe(false);
    expect(isPasskeyCeremonyCancellation(new Error("network down"))).toBe(false);
  });

  it("tolerates values that are not error-shaped", () => {
    expect(isPasskeyCeremonyCancellation(null)).toBe(false);
    expect(isPasskeyCeremonyCancellation(undefined)).toBe(false);
    expect(isPasskeyCeremonyCancellation("ERROR_CEREMONY_ABORTED")).toBe(false);
    expect(isPasskeyCeremonyCancellation({ code: 42, name: 7 })).toBe(false);
  });
});

describe("passkeyErrorMessage", () => {
  it("prefers the error's own message", () => {
    expect(passkeyErrorMessage(new Error("Passkey not recognized"), "fallback")).toBe(
      "Passkey not recognized"
    );
  });

  it("falls back when there is no usable message", () => {
    expect(passkeyErrorMessage({}, "fallback")).toBe("fallback");
    expect(passkeyErrorMessage({ message: "   " }, "fallback")).toBe("fallback");
    expect(passkeyErrorMessage({ message: 500 }, "fallback")).toBe("fallback");
    expect(passkeyErrorMessage(null, "fallback")).toBe("fallback");
  });
});
