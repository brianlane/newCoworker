import { describe, it, expect, vi } from "vitest";
import { resumeMigrationDeploy } from "@/lib/provisioning/resume-migration-deploy";

describe("resumeMigrationDeploy", () => {
  it("attaches to detached deploy on the current VM", async () => {
    const remoteExec = vi.fn(async (args: { command: string }) => {
      if (args.command.includes("flock -n")) {
        return { exitCode: 75, signal: null, stdout: "", stderr: "busy" };
      }
      return { exitCode: 0, signal: null, stdout: "0\nSTOPPED", stderr: "" };
    });
    const recordProgress = vi.fn(async () => ({}) as never);
    const out = await resumeMigrationDeploy(
      { businessId: "biz-1" },
      {
        getBusiness: async () =>
          ({ hostinger_vps_id: "1900001" }) as never,
        getActiveVpsSshKey: async () =>
          ({
            private_key_pem: "PEM",
            ssh_username: "root"
          }) as never,
        getLatestProvisioningStatus: async () => ({
          percent: 40,
          phase: "remote_deploy_starting",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "thinking"
        }),
        getSubscription: async () =>
          ({ hostinger_billing_subscription_id: "hbs-new" }) as never,
        recordProgress,
        hostingerGetVm: async () => ({
          ipv4: [{ address: "9.9.9.9" }],
          subscription_id: "hbs-new"
        }),
        remoteExec,
        sleep: async () => undefined
      }
    );
    expect(out).toEqual({
      vpsId: "1900001",
      hostingerBillingSubscriptionId: "hbs-new"
    });
    expect(recordProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "remote_deploy_resume" })
    );
    expect(recordProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "complete", percent: 100 })
    );
  });

  it("throws when the business has no VPS id", async () => {
    await expect(
      resumeMigrationDeploy(
        { businessId: "biz-1" },
        {
          getBusiness: async () => ({ hostinger_vps_id: null }) as never,
          hostingerGetVm: async () => ({ ipv4: [] })
        }
      )
    ).rejects.toThrow(/no hostinger_vps_id/);
  });

  it("throws when the VM has no IP", async () => {
    await expect(
      resumeMigrationDeploy(
        { businessId: "biz-1" },
        {
          getBusiness: async () =>
            ({ hostinger_vps_id: "1900001" }) as never,
          hostingerGetVm: async () => ({ ipv4: [] })
        }
      )
    ).rejects.toThrow(/no IP/);
  });

  it("throws when there is no SSH key", async () => {
    await expect(
      resumeMigrationDeploy(
        { businessId: "biz-1" },
        {
          getBusiness: async () =>
            ({ hostinger_vps_id: "1900001" }) as never,
          getActiveVpsSshKey: async () => null,
          hostingerGetVm: async () => ({
            ipv4: [{ address: "9.9.9.9" }]
          })
        }
      )
    ).rejects.toThrow(/no SSH key/);
  });
});
