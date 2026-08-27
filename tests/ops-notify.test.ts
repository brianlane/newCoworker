import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendOwnerEmailMock, loggerWarnMock, loggerInfoMock } = vi.hoisted(() => ({
  sendOwnerEmailMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn()
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: sendOwnerEmailMock
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    error: vi.fn(),
    debug: vi.fn()
  }
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn().mockResolvedValue({ tier: "starter" })
}));

import {
  sendOpsVpsDeletionEmail,
  sendOpsPlanChangeEmail,
  sendOpsDidReleaseFailedEmail,
  sendOpsHardwareMigrationEmail,
  sendOpsTermAlignmentEmail,
  sendOpsBillingPostureEmail,
  sendOpsOrphanSweepEmail,
  sendOpsMarginAlertEmail,
  sendOpsNewSignupEmail,
  sendOpsNangoQuotaEmail,
  sendOpsProvisioningStuckEmail,
  sendOpsDeployFailedEmail,
  sendOpsCronSweepHealthEmail,
  sendOpsIntakeCompletedEmail
} from "@/lib/email/ops-notify";
import { getBusiness } from "@/lib/db/businesses";

const input = {
  businessId: "biz-1",
  virtualMachineId: 1800985,
  hostingerBillingSubscriptionId: "hbs-1",
  ownerName: "Jane Doe",
  ownerEmail: "jane@example.com",
  tier: "standard",
  signupDate: "2026-06-01T00:00:00.000Z",
  refundIssued: false,
  cancelReason: "upgrade_switch",
  vmState: "VM stopped, auto-renew disabled"
};

describe("sendOpsVpsDeletionEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the deletion request to the ops inbox and logs the audit line", async () => {
    await sendOpsVpsDeletionEmail(input);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("srv1800985.hstgr.cloud"),
      expect.objectContaining({
        text: expect.stringContaining("hpanel.hostinger.com/paid-invoices")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops VPS deletion request emailed",
      expect.objectContaining({ businessId: "biz-1", toEmail: "team@newcoworker.com" })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsVpsDeletionEmail(input);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops VPS deletion email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1" })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsVpsDeletionEmail(input);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsVpsDeletionEmail(input)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops VPS deletion email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsVpsDeletionEmail(input)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops VPS deletion email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

const planChangeInput = {
  businessId: "biz-1",
  ownerName: "Jane Doe",
  ownerEmail: "jane@example.com",
  fromTier: "starter",
  toTier: "standard",
  billingPeriod: "monthly",
  oldVirtualMachineId: 1800985,
  fromHardware: "kvm2",
  toHardware: "kvm8"
};

describe("sendOpsPlanChangeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the escalation-start notice to the ops inbox and logs the audit line", async () => {
    await sendOpsPlanChangeEmail(planChangeInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("starter/kvm2 → standard/kvm8"),
      expect.objectContaining({
        text: expect.stringContaining("srv1800985.hstgr.cloud")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops plan-change (hardware escalation) start emailed",
      expect.objectContaining({
        businessId: "biz-1",
        fromTier: "starter",
        toTier: "standard",
        toEmail: "team@newcoworker.com"
      })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsPlanChangeEmail(planChangeInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops plan-change email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1" })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsPlanChangeEmail(planChangeInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsPlanChangeEmail(planChangeInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops plan-change email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsPlanChangeEmail(planChangeInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops plan-change email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

const termAlignmentInput = {
  businessId: "biz-1",
  ownerName: "Jane Doe",
  ownerEmail: "jane@example.com",
  tier: "starter",
  oldBillingPeriod: "monthly",
  newBillingPeriod: "biennial",
  outcome: "aligned" as const,
  currentCycleMonths: 1,
  targetTermMonths: 24,
  oldVirtualMachineId: 1800985,
  newVirtualMachineId: "1900001",
  detail: "Migrated onto a 24-month term box."
};

describe("sendOpsTermAlignmentEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the contract-switch summary to the ops inbox and logs the audit line", async () => {
    await sendOpsTermAlignmentEmail(termAlignmentInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("monthly → biennial"),
      expect.objectContaining({
        text: expect.stringContaining("srv1800985 → srv1900001")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops term-alignment email sent",
      expect.objectContaining({
        businessId: "biz-1",
        outcome: "aligned",
        newBillingPeriod: "biennial",
        toEmail: "team@newcoworker.com"
      })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsTermAlignmentEmail(termAlignmentInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops term-alignment email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1", outcome: "aligned" })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsTermAlignmentEmail(termAlignmentInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsTermAlignmentEmail(termAlignmentInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops term-alignment email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsTermAlignmentEmail(termAlignmentInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops term-alignment email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

const didReleaseFailedInput = {
  businessId: "biz-1",
  e164: "+16023131823",
  reason: "Telnyx 500: server error"
};

describe("sendOpsDidReleaseFailedEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the manual-release alert to the ops inbox and logs the audit line", async () => {
    await sendOpsDidReleaseFailedEmail(didReleaseFailedInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("+16023131823"),
      expect.objectContaining({
        text: expect.stringContaining("Telnyx 500: server error")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops DID-release-failed alert emailed",
      expect.objectContaining({
        businessId: "biz-1",
        e164: "+16023131823",
        toEmail: "team@newcoworker.com"
      })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsDidReleaseFailedEmail(didReleaseFailedInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops DID-release-failed email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1", e164: "+16023131823" })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsDidReleaseFailedEmail(didReleaseFailedInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsDidReleaseFailedEmail(didReleaseFailedInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops DID-release-failed email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsDidReleaseFailedEmail(didReleaseFailedInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops DID-release-failed email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

const hwMigrationInput = {
  phase: "started" as const,
  businessId: "biz-1",
  businessName: "Amy's Bakery",
  requestedBy: "brian@newcoworker.com",
  fromSize: "kvm2",
  toSize: "kvm4",
  detail: "Old box: srv1800985 (1.2.3.4). Flow: snapshot → backup → provision kvm4 → restore."
};

describe("sendOpsHardwareMigrationEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the migration progress email to the ops inbox and logs the audit line", async () => {
    await sendOpsHardwareMigrationEmail(hwMigrationInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("kvm2 → kvm4"),
      expect.objectContaining({
        text: expect.stringContaining("brian@newcoworker.com")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops hardware-migration email sent",
      expect.objectContaining({
        businessId: "biz-1",
        phase: "started",
        fromSize: "kvm2",
        toSize: "kvm4",
        toEmail: "team@newcoworker.com"
      })
    );
  });

  it("labels the failed phase loudly in the subject", async () => {
    await sendOpsHardwareMigrationEmail({ ...hwMigrationInput, phase: "failed" });
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("Hardware migration FAILED"),
      expect.anything()
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsHardwareMigrationEmail(hwMigrationInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops hardware-migration email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1", phase: "started" })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsHardwareMigrationEmail(hwMigrationInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsHardwareMigrationEmail(hwMigrationInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops hardware-migration email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsHardwareMigrationEmail(hwMigrationInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops hardware-migration email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });

  it("renders completed phase with the detail block in text and html", async () => {
    await sendOpsHardwareMigrationEmail({
      ...hwMigrationInput,
      phase: "completed",
      detail: "New box: srv1900001 (5.6.7.8). Old box srv1800985: stopped, billing=auto-renew-disabled."
    });
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("Hardware migration completed"),
      expect.objectContaining({
        text: expect.stringContaining("srv1900001"),
        html: expect.stringContaining("/admin/biz-1")
      })
    );
  });
});

describe("sendOpsBillingPostureEmail", () => {
  const postureInput = {
    findings: [
      {
        kind: "tenant_auto_renew_off" as const,
        vmId: 1800985,
        businessId: "biz-1",
        businessName: "Residency Pilot",
        hostingerBillingSubscriptionId: "hsub-1",
        expiresAt: "2026-08-02T00:00:00Z",
        autoHealed: true,
        detail: "subscription hsub-1 is non_renewing with auto-renew off, auto-renew re-enabled by posture check"
      }
    ],
    checkedTenantVms: 3,
    checkedPoolBoxes: 1
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the findings digest to the ops inbox", async () => {
    await sendOpsBillingPostureEmail(postureInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("VPS billing posture"),
      expect.objectContaining({ text: expect.stringContaining("VM 1800985") })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops billing-posture email sent",
      expect.objectContaining({ findings: 1, toEmail: "team@newcoworker.com" })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsBillingPostureEmail(postureInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops billing-posture email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ findings: 1 })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsBillingPostureEmail(postureInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsBillingPostureEmail(postureInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops billing-posture email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsBillingPostureEmail(postureInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops billing-posture email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

describe("sendOpsMarginAlertEmail", () => {
  const marginInput = {
    breaches: [
      {
        businessId: "biz-loss",
        businessName: "Loss Leader LLC",
        revenueCents: 18_900,
        costCents: 19_400,
        marginCents: -500
      }
    ],
    thresholdCents: 0
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the digest to the ops inbox and logs the audit line", async () => {
    await sendOpsMarginAlertEmail(marginInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("Margin alert: 1 paying tenant(s)"),
      expect.objectContaining({
        text: expect.stringContaining("Loss Leader LLC (biz-loss): margin -$5.00/mo")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops margin-alert email sent",
      expect.objectContaining({ breaches: 1, toEmail: "team@newcoworker.com" })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsMarginAlertEmail(marginInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops margin-alert email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ breaches: 1 })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsMarginAlertEmail(marginInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsMarginAlertEmail(marginInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops margin-alert email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsMarginAlertEmail(marginInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops margin-alert email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

describe("sendOpsNewSignupEmail", () => {
  const signupInput = {
    businessId: "biz-1",
    businessName: "Scar Fairy",
    ownerName: "Scar",
    ownerEmail: "scar@example.com",
    ownerPhone: "+16025551234",
    tier: "starter",
    billingPeriod: "annual" as const,
    virtualMachineId: "1800985",
    didE164: "+16025559999"
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the new-signup alert to the ops inbox", async () => {
    await expect(sendOpsNewSignupEmail(signupInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("New signup live"),
      expect.objectContaining({
        text: expect.stringContaining("Scar Fairy")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops new-signup email sent",
      expect.objectContaining({ businessId: "biz-1", toEmail: "team@newcoworker.com" })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendOpsNewSignupEmail(signupInput)).resolves.toBe(false);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops new-signup email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ businessId: "biz-1" })
    );
  });

  it("never throws when the send fails", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsNewSignupEmail(signupInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops new-signup email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsNewSignupEmail(signupInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops new-signup email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });

  it("tags enterprise tenants and falls back to localhost when app URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.mocked(getBusiness).mockResolvedValueOnce({ tier: "enterprise" } as never);
    await expect(sendOpsNewSignupEmail(signupInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("[ENTERPRISE]"),
      expect.objectContaining({
        html: expect.stringContaining("http://localhost:3000")
      })
    );
  });
});

describe("sendOpsNangoQuotaEmail", () => {
  const quotaInput = { used: 8, limit: 10 };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the near-limit alert to the ops inbox (no tier tag: platform-wide)", async () => {
    await expect(sendOpsNangoQuotaEmail(quotaInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      "[ops] Nango connections at 8/10",
      expect.objectContaining({
        text: expect.stringContaining("debug/nango-audit.ts"),
        html: expect.stringContaining("/admin/system")
      })
    );
    expect(getBusiness).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops Nango quota alert emailed",
      expect.objectContaining({ used: 8, limit: 10, toEmail: "team@newcoworker.com" })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendOpsNangoQuotaEmail(quotaInput)).resolves.toBe(false);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops Nango quota email skipped: RESEND_API_KEY missing",
      { used: 8, limit: 10 }
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await expect(sendOpsNangoQuotaEmail(quotaInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsNangoQuotaEmail(quotaInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops Nango quota email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsNangoQuotaEmail(quotaInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops Nango quota email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

describe("sendOpsDeployFailedEmail", () => {
  const failedInput = {
    businessId: "biz-1",
    businessName: "Acme Plumbing",
    virtualMachineId: "42",
    phase: "deploy_exception",
    reason: "deploy poll down"
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the deploy-failed alert to the ops inbox", async () => {
    await expect(sendOpsDeployFailedEmail(failedInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("Signup deploy FAILED"),
      expect.objectContaining({
        text: expect.stringContaining("deploy poll down")
      })
    );
  });

  it("returns false when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendOpsDeployFailedEmail(failedInput)).resolves.toBe(false);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await expect(sendOpsDeployFailedEmail(failedInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("returns false when send throws (Error and non-Error)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsDeployFailedEmail(failedInput)).resolves.toBe(false);

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsDeployFailedEmail(failedInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops deploy-failed email failed",
      expect.objectContaining({ error: "smtp down" })
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops deploy-failed email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

describe("sendOpsProvisioningStuckEmail", () => {
  const stuckInput = {
    businessId: "biz-1",
    businessName: "KYP Ads",
    phase: "remote_deploy_starting",
    percent: 40,
    ageMinutes: 25,
    purpose: "term_renewal",
    trigger: "stuck_progress_scan"
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the stuck alert to the ops inbox", async () => {
    await expect(sendOpsProvisioningStuckEmail(stuckInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("Provisioning stuck"),
      expect.objectContaining({
        text: expect.stringContaining("term_renewal")
      })
    );
  });

  it("returns false when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendOpsProvisioningStuckEmail(stuckInput)).resolves.toBe(false);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await expect(sendOpsProvisioningStuckEmail(stuckInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  it("returns false when send throws (Error and non-Error)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsProvisioningStuckEmail(stuckInput)).resolves.toBe(false);

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsProvisioningStuckEmail(stuckInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops provisioning-stuck email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

describe("sendOpsOrphanSweepEmail", () => {
  const sweepInput = {
    findings: [
      {
        kind: "pooled" as const,
        vmId: 1806114,
        plan: "KVM 1",
        state: "initial",
        createdAt: "2026-07-05T04:41:31Z",
        hostingerBillingSubscriptionId: "169rR3VOTEcjx7ysQ",
        expiresAt: "2026-08-05T04:41:30Z",
        detail: "pooled as available (kvm1), auto-renew already-off"
      }
    ],
    checkedVms: 10,
    dryRun: false
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the findings digest to the ops inbox", async () => {
    await sendOpsOrphanSweepEmail(sweepInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("Orphan sweep"),
      expect.objectContaining({ text: expect.stringContaining("VM 1806114") })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops orphan-sweep email sent",
      expect.objectContaining({ findings: 1, toEmail: "team@newcoworker.com" })
    );
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsOrphanSweepEmail(sweepInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops orphan-sweep email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ findings: 1 })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsOrphanSweepEmail(sweepInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  // A cron digest must never be able to take down the sweep that produced it.
  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsOrphanSweepEmail(sweepInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops orphan-sweep email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("plain string boom");
    await expect(sendOpsOrphanSweepEmail(sweepInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops orphan-sweep email failed",
      expect.objectContaining({ error: "plain string boom" })
    );
  });
});

describe("sendOpsIntakeCompletedEmail", () => {
  const intakeInput = {
    intakeId: "0f0f0f0f-0000-4000-8000-000000000001",
    businessName: "Acme Home Services",
    industry: "home_services",
    recipientEmail: "prospect@example.com",
    completedAt: "2026-08-21T19:56:12.345Z"
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the completion alert to the ops inbox and logs the audit line", async () => {
    await sendOpsIntakeCompletedEmail(intakeInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("White-glove questionnaire completed"),
      expect.objectContaining({
        text: expect.stringContaining("2026-08-21 19:56 UTC"),
        html: expect.stringContaining("/admin/intake-doc/0f0f0f0f-0000-4000-8000-000000000001")
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops intake-completed email sent",
      expect.objectContaining({
        intakeId: intakeInput.intakeId,
        businessName: "Acme Home Services",
        toEmail: "team@newcoworker.com"
      })
    );
  });

  it("is not tier-tagged: a prospect usually has no tenant yet", async () => {
    await sendOpsIntakeCompletedEmail(intakeInput);
    expect(getBusiness).not.toHaveBeenCalled();
    expect(sendOwnerEmailMock.mock.calls[0][2]).not.toContain("[ENTERPRISE]");
  });

  it("skips with a warning when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    await sendOpsIntakeCompletedEmail(intakeInput);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops intake-completed email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ intakeId: intakeInput.intakeId })
    );
  });

  it("falls back to localhost site URL when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsIntakeCompletedEmail(intakeInput);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.any(String),
      expect.objectContaining({ html: expect.stringContaining("http://localhost:3000") })
    );
  });

  // The prospect's submission is already saved when this fires; a dead
  // mailer must never turn their success into a 500.
  it("never throws when the send fails (Error and non-Error rejections)", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendOpsIntakeCompletedEmail(intakeInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops intake-completed email failed",
      expect.objectContaining({ error: "smtp down" })
    );

    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsIntakeCompletedEmail(intakeInput)).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops intake-completed email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});

describe("sendOpsCronSweepHealthEmail", () => {
  const watchdogInput = {
    findings: [
      {
        kind: "missing" as const,
        sweep: "subscription-grace-sweep",
        detail: "no run recorded in the last 1500 minutes (schedule 15 0 * * *)",
        action: "Check the live cron row first: tsx debug/read-cron-jobs.ts"
      }
    ],
    healthy: ["outreach-sweep"],
    checked: 23
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "resend_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.example.com";
    delete process.env.OPS_NOTIFICATION_EMAIL;
    sendOwnerEmailMock.mockResolvedValue(undefined);
  });

  it("sends the watchdog findings to the ops inbox", async () => {
    await expect(sendOpsCronSweepHealthEmail(watchdogInput)).resolves.toBe(true);
    expect(sendOwnerEmailMock).toHaveBeenCalledWith(
      "resend_test",
      "team@newcoworker.com",
      expect.stringContaining("ACTION REQUIRED"),
      expect.objectContaining({ text: expect.stringContaining("subscription-grace-sweep") })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "ops cron-sweep-health email sent",
      expect.objectContaining({ findings: 1, toEmail: "team@newcoworker.com" })
    );
  });

  it("is not tier-tagged: the scheduled fleet belongs to no single tenant", async () => {
    await sendOpsCronSweepHealthEmail(watchdogInput);
    expect(sendOwnerEmailMock.mock.calls[0][2]).not.toContain("[ENTERPRISE]");
  });

  it("falls back to localhost when no app URL is set", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendOpsCronSweepHealthEmail(watchdogInput);
    expect(sendOwnerEmailMock.mock.calls[0][3].html).toContain("http://localhost:3000");
  });

  it("skips without a Resend key rather than throwing inside a cron route", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendOpsCronSweepHealthEmail(watchdogInput)).resolves.toBe(false);
    expect(sendOwnerEmailMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops cron-sweep-health email skipped: RESEND_API_KEY missing",
      expect.objectContaining({ findings: 1 })
    );
  });

  it("swallows a send failure, so a dead mailer cannot fail the watchdog run", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce(new Error("resend down"));
    await expect(sendOpsCronSweepHealthEmail(watchdogInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops cron-sweep-health email failed",
      expect.objectContaining({ error: "resend down" })
    );
  });

  it("stringifies a non-Error send failure", async () => {
    sendOwnerEmailMock.mockRejectedValueOnce("smtp string failure");
    await expect(sendOpsCronSweepHealthEmail(watchdogInput)).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "ops cron-sweep-health email failed",
      expect.objectContaining({ error: "smtp string failure" })
    );
  });
});
