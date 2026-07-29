import { describe, it, expect, vi } from "vitest";
import { buildOpsProvisioningStuckEmail } from "@/lib/email/templates/ops-provisioning-stuck";
import {
  isStuckProgressBand,
  maybeSendProvisioningStuckAlert,
  selectStuckScanCandidates,
  alertFromWatchdogResult,
  scanAndAlertStuckProvisioning,
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
        phase: "pulling_images",
        percent: 55,
        logStatus: "thinking"
      })
    ).toBe(true);
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

  it("keeps job-failed candidates even when the business is offline", () => {
    const now = Date.parse("2026-07-29T10:25:00.000Z");
    const rows: StuckScanCandidate[] = [
      {
        businessId: "biz-2",
        phase: "remote_deploy_starting",
        percent: 40,
        updatedAt: "2026-07-29T10:00:00.000Z",
        logStatus: "thinking",
        businessStatus: "offline",
        purpose: "signup",
        jobStatus: "failed"
      }
    ];
    expect(selectStuckScanCandidates(rows, now)).toHaveLength(1);
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

describe("scanAndAlertStuckProvisioning", () => {
  it("alerts matching candidates from the injected list", async () => {
    const sendEmail = vi.fn(async () => true);
    const now = Date.parse("2026-07-29T10:25:00.000Z");
    const out = await scanAndAlertStuckProvisioning({
      sendEmail,
      hasPriorAlert: async () => false,
      recordProgress: vi.fn(async () => ({}) as never),
      getBusinessName: async () => "KYP Ads",
      now: () => now,
      listCandidates: async () => [
        {
          businessId: "biz-1",
          phase: "remote_deploy_starting",
          percent: 40,
          updatedAt: "2026-07-29T10:00:00.000Z",
          logStatus: "thinking",
          businessStatus: "online",
          purpose: "term_renewal",
          jobStatus: null
        }
      ]
    });
    expect(out.alerted).toEqual(["biz-1"]);
    expect(sendEmail).toHaveBeenCalledOnce();
  });
});

describe("maybeSendProvisioningStuckAlert error paths", () => {
  it("still emails when prior-alert lookup throws", async () => {
    const sendEmail = vi.fn(async () => true);
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
        hasPriorAlert: async () => {
          throw new Error("db down");
        },
        recordProgress: vi.fn(async () => ({}) as never),
        getBusinessName: async () => "Acme"
      }
    );
    expect(sent).toBe(true);
  });

  it("returns false when email is not sent", async () => {
    const sent = await maybeSendProvisioningStuckAlert(
      {
        businessId: "biz-1",
        phase: "remote_deploy_starting",
        percent: 40,
        ageMinutes: 25,
        purpose: "signup",
        trigger: "retry_failed"
      },
      {
        sendEmail: async () => false,
        hasPriorAlert: async () => false,
        getBusinessName: async () => "Acme"
      }
    );
    expect(sent).toBe(false);
  });

  it("tolerates dedupe progress write failure after a successful send", async () => {
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
        sendEmail: async () => true,
        hasPriorAlert: async () => false,
        recordProgress: async () => {
          throw new Error("write fail");
        },
        getBusinessName: async () => "Acme"
      }
    );
    expect(sent).toBe(true);
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

  it("still alerts when latest progress lookup throws", async () => {
    const sendEmail = vi.fn(async () => true);
    await alertFromWatchdogResult(
      { kind: "retry_failed", businessId: "biz-a", attempts: 1, error: "x" },
      {
        sendEmail,
        hasPriorAlert: async () => false,
        recordProgress: vi.fn(async () => ({}) as never),
        getBusinessName: async () => "Acme",
        getLatestStatus: async () => {
          throw new Error("logs down");
        }
      }
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-a", phase: "unknown" })
    );
  });
});
