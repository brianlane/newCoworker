import { describe, expect, it } from "vitest";

import { messengerAllowedForTier } from "@/lib/messenger/tier-gate";

/**
 * The predicate is the whole gate: the messenger worker is the single
 * consumer of the reply engine and checks it before running a turn
 * (covered in tests/messenger-worker.test.ts). The old throwing assert
 * had no production callers and was deleted, so nothing here mocks a
 * database.
 */
describe("messenger tier gate", () => {
  it("allows standard and enterprise only", () => {
    expect(messengerAllowedForTier("standard")).toBe(true);
    expect(messengerAllowedForTier("enterprise")).toBe(true);
    expect(messengerAllowedForTier("starter")).toBe(false);
    expect(messengerAllowedForTier("")).toBe(false);
    expect(messengerAllowedForTier(null)).toBe(false);
    expect(messengerAllowedForTier(undefined)).toBe(false);
  });
});
