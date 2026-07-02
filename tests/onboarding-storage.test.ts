import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOnboardingStorage,
  DRAFT_STORAGE_KEY,
  ONBOARD_STORAGE_KEY
} from "@/lib/onboarding/storage";

describe("onboarding storage constants", () => {
  it("uses the expected localStorage keys", () => {
    expect(ONBOARD_STORAGE_KEY).toBe("newcoworker_onboard");
    expect(DRAFT_STORAGE_KEY).toBe("newcoworker_onboard_draft");
  });
});

describe("clearOnboardingStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes both onboarding keys from localStorage", () => {
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { removeItem });

    clearOnboardingStorage();

    expect(removeItem).toHaveBeenCalledWith(ONBOARD_STORAGE_KEY);
    expect(removeItem).toHaveBeenCalledWith(DRAFT_STORAGE_KEY);
  });

  it("swallows storage errors (private mode / storage disabled)", () => {
    vi.stubGlobal("localStorage", {
      removeItem: vi.fn(() => {
        throw new Error("storage disabled");
      })
    });

    expect(() => clearOnboardingStorage()).not.toThrow();
  });
});
