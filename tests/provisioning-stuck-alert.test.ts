import { describe, it, expect, vi } from "vitest";
import { buildOpsProvisioningStuckEmail } from "@/lib/email/templates/ops-provisioning-stuck";
import {
  isStuckProgressBand,
  maybeSendProvisioningStuckAlert,
  selectStuckScanCandidates,
  alertFromWatchdogResult,
  type StuckScanCandidate
} from "@/lib/provisioning/stuck-alert";

describe("buildOpsProvisioningStuckEmail", () => {
  it("includes business id, phase, percent, age, purpose (no em dash)", () => {
    const email = buildOpsProvisioningStuckEmail({
      businessId: "biz-1",
      businessName: "KYP Ads",
      phase: "remote_deploy_starting",
      percent: 40,
      ageMinutes: 25,
      purpose: "term_renewal",
      trigger: "stuck_progress_scan",
      siteUrl: "https://app.example.com"
    });
    expect(email.subject).toContain("Provisioning stuck");
    expect(email.subject).toContain("40%");
    expect(email.text).toContain("biz-1");
    expect(email.text).toContain("remote_deploy_starting");
    expect(email.text).toContain("Age: 25 minutes");
    expect(email.text).toContain("Purpose: term_renewal");
    expect(email.text).not.toMatch(/\u2014/);
    expect(email.html).toContain("/admin/biz-1");
  });
});

describe("isStuckProgressBand", () => {
  it("matches mid-deploy non-terminal rows", () => {
    expect(
      isStuckProgressBand({
        phase: "remote_deploy_starting",
        percent: 40,
        logStatus: "thinking"
      })
    ).toBe(true);
    expect(
      isStuckProgressBand({
        phase: "complete",
        percent: 100,
        logStatus: "success"
      })
    ).toBe(false);
    expect(
      isStuckProgressBand({
        phase: "deploy_failed",
        percent: 95,
        logStatus: "error"
      })
    ).toBe(false);
  });
});

describe("selectStuckScanCandidates", () => {
  const base: StuckScanCandidate = {
    businessId: "biz-1",
    phase: "remote_deploy_starting",
    percent: 40,
    updatedAt: "2026-07-29T10:00:00.000Z",
    logStatus: "thinking",
    businessStatus: "online",
    purpose: "term_renewal",
    jobStatus: null
  };

  it("keeps KYP-shaped online + mid percent older than 20m", () => {
    const now = Date.parse("2026-07-29T10:25:00.000Z");
    expect(selectStuckScanCandidates([base], now)).toHaveLength(1);
  });

  it("drops fresh progress", () => {
    const now = Date.parse("2026-07-29T10:05:00.000Z");
    expect(selectStuckScanCandidates([base], now)).toHaveLength(0);
  });
});

describe("maybeSendProvisioningStuckAlert", () => {
  it("alerts once and writes dedupe phase", async () => {
    const sendEmail = vi.fn(async () => true);
    const recordProgress = vi.fn(async () => ({}) as never);
    const sent = await maybeSendProvisioningStuckAlert(
      {
        businessId: "biz-1",
        phase: "remote_deploy_starting",
        percent: 40,
        ageMinutes: 25,
        purpose: "term_renewal",
        trigger: "stuck_progress_scan"
      },
      {
        sendEmail,
        hasPriorAlert: async () => false,
        recordProgress,
        getBusinessName: async () => "KYP Ads"
      }
    );
    expect(sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(recordProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        phase: "ops_provisioning_stuck_alert_sent"
      })
    );

    const again = await maybeSendProvisioningStuckAlert(
      {
        businessId: "biz-1",
        phase: "remote_deploy_starting",
        percent: 40,
        ageMinutes: 30,
        purpose: "term_renewal",
        trigger: "stuck_progress_scan"
      },
      {
        sendEmail,
        hasPriorAlert: async () => true,
        recordProgress,
        getBusinessName: async () => "KYP Ads"
      }
    );
    expect(again).toBe(false);
    expect(sendEmail).toHaveBeenCalledOnce();
  });
});

describe("alertFromWatchdogResult", () => {
  it("alerts on retry_failed and exhaustedFailed", async () => {
    const sendEmail = vi.fn(async () => true);
    await alertFromWatchdogResult(
      {
        kind: "retry_failed",
        businessId: "biz-a",
        attempts: 3,
        error: "boom",
        exhaustedFailed: ["biz-b"]
      },
      {
        sendEmail,
        hasPriorAlert: async () => false,
        recordProgress: vi.fn(async () => ({}) as never),
        getBusinessName: async (id) => id,
        getLatestStatus: async () => ({
          percent: 40,
          phase: "remote_deploy_starting",
          updatedAt: "2026-07-29T10:00:00.000Z",
          logStatus: "thinking"
        }),
        now: () => Date.parse("2026-07-29T10:30:00.000Z")
      }
    );
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "retry_failed", businessId: "biz-a" })
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "exhausted_failed", businessId: "biz-b" })
    );
  });
});
