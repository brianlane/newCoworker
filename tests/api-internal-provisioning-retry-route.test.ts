import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/provisioning/jobs", () => ({ retryStalledProvisioningJob: vi.fn() }));
vi.mock("@/lib/provisioning/orchestrate", () => ({ orchestrateProvisioning: vi.fn() }));
vi.mock("@/lib/provisioning/stuck-alert", () => ({
  alertFromWatchdogResult: vi.fn(),
  scanAndAlertStuckProvisioning: vi.fn()
}));
vi.mock("@/lib/provisioning/resume-migration-deploy", () => ({ resumeMigrationDeploy: vi.fn() }));
vi.mock("@/lib/provisioning/progress", () => ({ getLatestProvisioningStatus: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/subscriptions", () => ({ getSubscription: vi.fn(), updateSubscription: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/billing/heal-plan-change-aftereffects", () => ({
  healPlanChangeAftereffects: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/internal/provisioning-retry/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { retryStalledProvisioningJob } from "@/lib/provisioning/jobs";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { scanAndAlertStuckProvisioning } from "@/lib/provisioning/stuck-alert";
import { healPlanChangeAftereffects } from "@/lib/billing/heal-plan-change-aftereffects";
import { logger } from "@/lib/logger";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/provisioning-retry", {
    method: "POST",
    headers: { Authorization: "Bearer cron-secret" }
  });
}

describe("api/internal/provisioning-retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(retryStalledProvisioningJob).mockResolvedValue({ kind: "idle" } as never);
    vi.mocked(orchestrateProvisioning).mockResolvedValue({
      vpsId: "1900001",
      hostingerBillingSubscriptionId: null
    } as never);
    vi.mocked(scanAndAlertStuckProvisioning).mockResolvedValue({ alerted: [] });
    vi.mocked(healPlanChangeAftereffects).mockResolvedValue({ scanned: 0, actions: [] });
  });

  it("403s without a valid cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(retryStalledProvisioningJob).not.toHaveBeenCalled();
  });

  /**
   * The watchdog's `orchestrate` wrapper rebuilds its input field by field
   * rather than spreading it, so anything not listed there is silently
   * dropped. Since the purchase default became monthly, dropping
   * `hostingerTerm` means a stalled term_renewal or contract_upgrade job
   * that falls through to a full re-provision buys a MONTHLY box instead of
   * the term its sweep computed and stored on the job row, quietly defeating
   * the sweep that enqueued it. Nothing else fails, which is what makes it
   * worth pinning.
   */
  it("forwards the job's stored Hostinger term into the re-provision", async () => {
    await POST(makeRequest());
    const deps = vi.mocked(retryStalledProvisioningJob).mock.calls[0][0];

    await deps.orchestrate({
      businessId: "biz-1",
      tier: "standard",
      vpsSize: "kvm2",
      billingPeriod: "biennial",
      hostingerTerm: "2y"
    });

    expect(orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerTerm: "2y" })
    );
  });

  it("passes a null term through untouched, so a signup keeps the monthly default", async () => {
    await POST(makeRequest());
    const deps = vi.mocked(retryStalledProvisioningJob).mock.calls[0][0];

    await deps.orchestrate({
      businessId: "biz-2",
      tier: "starter",
      vpsSize: "kvm1",
      billingPeriod: null,
      hostingerTerm: null
    });

    expect(orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerTerm: null })
    );
  });

  it("runs the plan-change aftereffects heal each tick", async () => {
    vi.mocked(healPlanChangeAftereffects).mockResolvedValue({
      scanned: 1,
      actions: [{ businessId: "biz-kin", action: "reclaimed_pooled_vm", detail: "1936826" }]
    });
    const res = await POST(makeRequest());
    expect(healPlanChangeAftereffects).toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.planChangeHeal.actions[0].action).toBe("reclaimed_pooled_vm");
    expect(logger.info).toHaveBeenCalledWith(
      "plan-change aftereffects heal",
      expect.objectContaining({ scanned: 1 })
    );
  });

  it("continues the watchdog tick when the plan-change heal throws", async () => {
    vi.mocked(healPlanChangeAftereffects).mockRejectedValueOnce(new Error("heal boom"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "plan-change aftereffects heal failed",
      expect.objectContaining({ error: "heal boom" })
    );
  });
});
