import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConfidentialBrowserStorage,
  CONFIDENTIAL_SESSION_STORAGE_KEYS
} from "@/lib/auth/clear-confidential-storage";
import { DRAFT_STORAGE_KEY, ONBOARD_STORAGE_KEY } from "@/lib/onboarding/storage";

describe("clearConfidentialBrowserStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears onboarding localStorage and confidential sessionStorage keys", () => {
    const localRemove = vi.fn();
    const sessionRemove = vi.fn();
    vi.stubGlobal("localStorage", { removeItem: localRemove });
    vi.stubGlobal("sessionStorage", { removeItem: sessionRemove });

    clearConfidentialBrowserStorage();

    expect(localRemove).toHaveBeenCalledWith(ONBOARD_STORAGE_KEY);
    expect(localRemove).toHaveBeenCalledWith(DRAFT_STORAGE_KEY);
    for (const key of CONFIDENTIAL_SESSION_STORAGE_KEYS) {
      expect(sessionRemove).toHaveBeenCalledWith(key);
    }
  });

  it("swallows storage errors", () => {
    vi.stubGlobal("localStorage", {
      removeItem: vi.fn(() => {
        throw new Error("disabled");
      })
    });
    vi.stubGlobal("sessionStorage", {
      removeItem: vi.fn(() => {
        throw new Error("disabled");
      })
    });
    expect(() => clearConfidentialBrowserStorage()).not.toThrow();
  });
});
