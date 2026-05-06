/**
 * Pure-function tests for `resolveSmsCampaignCopy`.
 *
 * The full PhoneNumberCard requires React + DOM and is exercised end-to-end
 * by Playwright; here we lock down the copy/severity mapping that the
 * dashboard banner depends on so a copy-paste regression doesn't silently
 * mislead customers about whether SMS is up.
 */

import { describe, expect, it } from "vitest";
import { resolveSmsCampaignCopy } from "@/components/dashboard/PhoneNumberCard";

describe("resolveSmsCampaignCopy", () => {
  it("returns null when status is missing (unknown/uninitialized — don't show a banner)", () => {
    expect(resolveSmsCampaignCopy(null)).toBeNull();
    expect(resolveSmsCampaignCopy(undefined)).toBeNull();
  });

  it("returns null when registered (happy path — no UI noise)", () => {
    expect(resolveSmsCampaignCopy("registered")).toBeNull();
  });

  it("returns null when unregistered (explicit detach — no banner)", () => {
    expect(resolveSmsCampaignCopy("unregistered")).toBeNull();
  });

  it("returns a pending banner with the carrier-vetting hint", () => {
    const c = resolveSmsCampaignCopy("pending");
    expect(c).not.toBeNull();
    expect(c?.variant).toBe("pending");
    expect(c?.label).toMatch(/SMS being registered/i);
    expect(c?.hint).toMatch(/carriers/i);
    expect(c?.hint).toMatch(/1-2 business days/i);
  });

  it("returns an error banner with retry copy when rejected", () => {
    const c = resolveSmsCampaignCopy("rejected");
    expect(c).not.toBeNull();
    expect(c?.variant).toBe("error");
    expect(c?.label).toMatch(/needs attention/i);
    expect(c?.hint).toMatch(/automatically retry/i);
  });
});
