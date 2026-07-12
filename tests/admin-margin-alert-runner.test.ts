import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/admin/platform-settings", () => ({
  getAdminPlatformSetting: vi.fn()
}));
vi.mock("@/lib/admin/margin-data", () => ({
  loadFleetMargins: vi.fn()
}));
vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsMarginAlertEmail: vi.fn(async () => {})
}));

import { runProductionMarginAlert } from "@/lib/admin/margin-alert-runner";
import { MARGIN_ALERT_SETTINGS_KEY } from "@/lib/admin/margin-alert";
import { getAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import { sendOpsMarginAlertEmail } from "@/lib/email/ops-notify";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runProductionMarginAlert", () => {
  it("wires config, fleet economics, and the ops email together", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue({
      enabled: true,
      thresholdCents: 0
    });
    vi.mocked(loadFleetMargins).mockResolvedValue({
      economics: [
        {
          businessId: "biz-loss",
          revenueCents: 18_900,
          revenueSource: "subscription",
          lines: [],
          costCents: 19_400,
          marginCents: -500
        }
      ],
      businesses: [{ id: "biz-loss", name: "Loss Leader LLC" }]
    } as never);

    const result = await runProductionMarginAlert();
    expect(getAdminPlatformSetting).toHaveBeenCalledWith(MARGIN_ALERT_SETTINGS_KEY);
    expect(result.emailed).toBe(true);
    expect(sendOpsMarginAlertEmail).toHaveBeenCalledWith({
      breaches: [expect.objectContaining({ businessName: "Loss Leader LLC" })],
      thresholdCents: 0
    });
  });

  it("does not load the fleet when disabled", async () => {
    vi.mocked(getAdminPlatformSetting).mockResolvedValue(null);
    const result = await runProductionMarginAlert();
    expect(result.enabled).toBe(false);
    expect(loadFleetMargins).not.toHaveBeenCalled();
  });
});
