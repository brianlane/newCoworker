import { describe, expect, it } from "vitest";
import { ONBOARD_STORAGE_KEY } from "@/lib/onboarding/storage";

describe("onboarding storage constants", () => {
  it("uses the expected localStorage key", () => {
    expect(ONBOARD_STORAGE_KEY).toBe("newcoworker_onboard");
  });
});
