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

import {
  sendOpsVpsDeletionEmail,
  sendOpsPlanChangeEmail,
  sendOpsDidReleaseFailedEmail,
  sendOpsHardwareMigrationEmail
} from "@/lib/email/ops-notify";

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
