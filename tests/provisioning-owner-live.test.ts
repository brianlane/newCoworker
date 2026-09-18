import { describe, expect, it } from "vitest";
import {
  isProvisioningStatusLive,
  onboardSuccessLiveFromPoll
} from "@/lib/provisioning/owner-live";
import { shouldShowProvisioningProgress } from "@/lib/provisioning/progress";

/**
 * Same mapping GET /api/provisioning/status uses for `complete` / `failed`.
 * Kept local so these tests prove alignment without going through the route.
 */
function provisioningStatusPayload(
  businessStatus: string,
  latest: Parameters<typeof shouldShowProvisioningProgress>[1]
): { complete: boolean; failed: boolean; percent: number } {
  return {
    percent: latest?.percent ?? 0,
    complete: !shouldShowProvisioningProgress(businessStatus, latest),
    failed: latest?.logStatus === "error"
  };
}

describe("isProvisioningStatusLive", () => {
  it("is false when provisioning is not complete (dashboard still shows the bar)", () => {
    expect(isProvisioningStatusLive({ complete: false, failed: false })).toBe(false);
  });

  it("is true when provisioning is complete and not failed (dashboard hides the bar)", () => {
    expect(isProvisioningStatusLive({ complete: true, failed: false })).toBe(true);
  });

  it("treats omitted failed as not-failed when complete is true", () => {
    expect(isProvisioningStatusLive({ complete: true })).toBe(true);
  });

  it("is false when complete is true but failed is true (deploy error, online for recovery)", () => {
    expect(isProvisioningStatusLive({ complete: true, failed: true })).toBe(false);
  });

  it("is false when the payload is missing", () => {
    expect(isProvisioningStatusLive(null)).toBe(false);
    expect(isProvisioningStatusLive(undefined)).toBe(false);
  });

  it("is false when complete is omitted", () => {
    expect(isProvisioningStatusLive({ failed: false })).toBe(false);
  });
});

describe("onboardSuccessLiveFromPoll", () => {
  it("does not claim live from businesses.status === online alone while percent is still in progress", () => {
    // BA Fitness split-brain: orchestrator had already flipped status to
    // online during remote_deploy_starting (~40%), while the dashboard bar
    // still showed in-progress because latest percent was < 100.
    const live = onboardSuccessLiveFromPoll({
      businessStatus: "online",
      provisioning: { complete: false, failed: false, percent: 40 }
    });
    expect(live).toBe(false);
  });

  it("claims live only once provisioning complete matches the dashboard hide-bar gate", () => {
    expect(
      onboardSuccessLiveFromPoll({
        businessStatus: "online",
        provisioning: { complete: true, failed: false, percent: 100 }
      })
    ).toBe(true);
  });

  it("ignores businesses.status and trusts the provisioning complete flag", () => {
    expect(
      onboardSuccessLiveFromPoll({
        businessStatus: "offline",
        provisioning: { complete: true, failed: false, percent: 100 }
      })
    ).toBe(true);
    expect(
      onboardSuccessLiveFromPoll({
        businessStatus: "online",
        provisioning: { complete: false, failed: false, percent: 40 }
      })
    ).toBe(false);
  });

  it("does not claim live on a recoverable deploy failure (status online, failed true)", () => {
    expect(
      onboardSuccessLiveFromPoll({
        businessStatus: "online",
        provisioning: { complete: true, failed: true, percent: 95 }
      })
    ).toBe(false);
  });

  it("does not claim live when the provisioning poll has not returned yet", () => {
    expect(
      onboardSuccessLiveFromPoll({
        businessStatus: "online",
        provisioning: null
      })
    ).toBe(false);
  });
});

describe("owner live copy aligns with shouldShowProvisioningProgress", () => {
  it("stays off while online at remote_deploy_starting 40% (dashboard still shows the bar)", () => {
    const latest = {
      percent: 40,
      updatedAt: "2026-09-18T00:00:00Z",
      phase: "remote_deploy_starting",
      logStatus: "thinking" as const
    };
    expect(shouldShowProvisioningProgress("online", latest)).toBe(true);
    expect(isProvisioningStatusLive(provisioningStatusPayload("online", latest))).toBe(false);
  });

  it("turns on when online at 100% (dashboard hides the bar)", () => {
    const latest = {
      percent: 100,
      updatedAt: "2026-09-18T00:00:00Z",
      phase: "complete",
      logStatus: "success" as const
    };
    expect(shouldShowProvisioningProgress("online", latest)).toBe(false);
    expect(isProvisioningStatusLive(provisioningStatusPayload("online", latest))).toBe(true);
  });

  it("turns on when high_load at 100% (same hide-bar gate as dashboard)", () => {
    const latest = {
      percent: 100,
      updatedAt: "2026-09-18T00:00:00Z",
      phase: "complete",
      logStatus: "success" as const
    };
    expect(shouldShowProvisioningProgress("high_load", latest)).toBe(false);
    expect(isProvisioningStatusLive(provisioningStatusPayload("high_load", latest))).toBe(true);
  });

  it("stays off on a terminal deploy error even though the dashboard hides the in-progress bar", () => {
    const latest = {
      percent: 95,
      updatedAt: "2026-09-18T00:00:00Z",
      phase: "deploy_failed",
      logStatus: "error" as const
    };
    expect(shouldShowProvisioningProgress("online", latest)).toBe(false);
    expect(isProvisioningStatusLive(provisioningStatusPayload("online", latest))).toBe(false);
  });

  it("turns on when online with no provisioning rows (dashboard treats that as already ready)", () => {
    expect(shouldShowProvisioningProgress("online", null)).toBe(false);
    expect(isProvisioningStatusLive(provisioningStatusPayload("online", null))).toBe(true);
  });
});
