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

import { sendOpsVpsDeletionEmail } from "@/lib/email/ops-notify";

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
