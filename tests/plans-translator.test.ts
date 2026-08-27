import { describe, expect, it } from "vitest";

import {
  TRANSLATOR_UPGRADE_MESSAGE,
  translatorAllowedForTier
} from "@/lib/plans/translator";

describe("translator tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(translatorAllowedForTier("standard")).toBe(true);
    expect(translatorAllowedForTier("enterprise")).toBe(true);
    expect(translatorAllowedForTier("starter")).toBe(false);
    expect(translatorAllowedForTier(null)).toBe(false);
    expect(translatorAllowedForTier(undefined)).toBe(false);
  });

  it("exposes an upgrade message naming Standard", () => {
    expect(TRANSLATOR_UPGRADE_MESSAGE).toContain("Standard");
  });


});
