import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

import {
  getEnterpriseSupportContact,
  ENTERPRISE_SLA_TARGETS
} from "@/lib/plans/enterprise-support";
import { hasPrioritySupportForTier, hasPrioritySupport } from "@/lib/plans/white-glove";
import { tagOpsSubjectForTier } from "@/lib/email/ops-notify";
import { getBusiness } from "@/lib/db/businesses";

const NOW = new Date("2026-07-08T00:00:00Z");

describe("hasPrioritySupportForTier", () => {
  it("is permanently open for enterprise, regardless of the window", () => {
    expect(hasPrioritySupportForTier("enterprise", null, NOW)).toBe(true);
    expect(hasPrioritySupportForTier("enterprise", "2020-01-01T00:00:00Z", NOW)).toBe(true);
  });

  it("falls back to the white-glove window for other tiers", () => {
    expect(hasPrioritySupportForTier("standard", "2026-08-01T00:00:00Z", NOW)).toBe(true);
    expect(hasPrioritySupportForTier("standard", "2020-01-01T00:00:00Z", NOW)).toBe(false);
    expect(hasPrioritySupportForTier("starter", null, NOW)).toBe(false);
    expect(hasPrioritySupportForTier(null, null, NOW)).toBe(false);
    // Parity with the underlying window check.
    expect(hasPrioritySupport("2026-08-01T00:00:00Z", NOW)).toBe(true);
  });
});

describe("getEnterpriseSupportContact", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("reads trimmed env channels and nulls unset/blank ones", () => {
    process.env.ENTERPRISE_SUPPORT_EMAIL = " vip@newcoworker.com ";
    process.env.ENTERPRISE_SUPPORT_PHONE = "+16025551234";
    delete process.env.ENTERPRISE_SUPPORT_BOOKING_URL;
    expect(getEnterpriseSupportContact()).toEqual({
      email: "vip@newcoworker.com",
      phone: "+16025551234",
      bookingUrl: null
    });

    process.env.ENTERPRISE_SUPPORT_EMAIL = "   ";
    expect(getEnterpriseSupportContact().email).toBeNull();
  });

  it("publishes the SLA targets the card renders", () => {
    expect(ENTERPRISE_SLA_TARGETS.length).toBeGreaterThanOrEqual(3);
    expect(ENTERPRISE_SLA_TARGETS[0].target).toContain("1 hour");
  });
});

describe("tagOpsSubjectForTier", () => {
  it("prefixes [ENTERPRISE] for enterprise tenants only", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ tier: "enterprise" } as never);
    expect(await tagOpsSubjectForTier("VPS deletion request", "biz-1")).toBe(
      "[ENTERPRISE] VPS deletion request"
    );

    vi.mocked(getBusiness).mockResolvedValue({ tier: "standard" } as never);
    expect(await tagOpsSubjectForTier("VPS deletion request", "biz-1")).toBe(
      "VPS deletion request"
    );

    vi.mocked(getBusiness).mockResolvedValue(null);
    expect(await tagOpsSubjectForTier("x", "biz-1")).toBe("x");
  });

  it("returns the subject untagged when the lookup fails (never blocks the alert)", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("db down"));
    expect(await tagOpsSubjectForTier("Alert", "biz-1")).toBe("Alert");
  });
});
