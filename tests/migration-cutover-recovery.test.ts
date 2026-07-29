import { describe, it, expect, vi } from "vitest";
import { tryRecoverDeployCompleteNewBox } from "@/lib/vps/migration-cutover-recovery";

describe("tryRecoverDeployCompleteNewBox", () => {
  it("returns null when hostinger_vps_id still points at the old VM", async () => {
    const out = await tryRecoverDeployCompleteNewBox(
      { businessId: "biz-1", oldVmId: 100 },
      {
        getBusiness: async () => ({ hostinger_vps_id: "100" }),
        getLatestProvisioningStatus: async () => ({
          percent: 100,
          phase: "complete",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "success"
        }),
        getVirtualMachine: async () => ({ ipv4: [{ address: "1.1.1.1" }] })
      }
    );
    expect(out).toBeNull();
  });

  it("recovers when progress phase is deploy_client_complete", async () => {
    const out = await tryRecoverDeployCompleteNewBox(
      { businessId: "biz-1", oldVmId: 100 },
      {
        getBusiness: async () => ({ hostinger_vps_id: "200" }),
        getLatestProvisioningStatus: async () => ({
          percent: 100,
          phase: "deploy_client_complete",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "thinking"
        }),
        getVirtualMachine: async () => ({
          ipv4: [{ address: "9.9.9.9" }],
          subscription_id: "hbs-new"
        })
      }
    );
    expect(out).toEqual({
      vpsId: "200",
      hostingerBillingSubscriptionId: "hbs-new"
    });
  });

  it("recovers via exit file when progress is mid-deploy", async () => {
    const remoteExec = vi.fn(async () => ({
      exitCode: 0,
      stdout: "0\n",
      stderr: ""
    }));
    const out = await tryRecoverDeployCompleteNewBox(
      { businessId: "biz-1", oldVmId: 100 },
      {
        getBusiness: async () => ({ hostinger_vps_id: "200" }),
        getLatestProvisioningStatus: async () => ({
          percent: 40,
          phase: "remote_deploy_starting",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "thinking"
        }),
        getVirtualMachine: async () => ({ ipv4: [{ address: "9.9.9.9" }] }),
        getActiveVpsSshKey: async () => ({
          private_key_pem: "PEM",
          ssh_username: "root"
        }),
        remoteExec
      }
    );
    expect(out?.vpsId).toBe("200");
    expect(remoteExec).toHaveBeenCalled();
  });

  it("returns null when new box is unhealthy", async () => {
    const out = await tryRecoverDeployCompleteNewBox(
      { businessId: "biz-1", oldVmId: 100 },
      {
        getBusiness: async () => ({ hostinger_vps_id: "200" }),
        getLatestProvisioningStatus: async () => ({
          percent: 40,
          phase: "remote_deploy_starting",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "thinking"
        }),
        getVirtualMachine: async () => ({ ipv4: [{ address: "9.9.9.9" }] }),
        getActiveVpsSshKey: async () => ({
          private_key_pem: "PEM",
          ssh_username: "root"
        }),
        remoteExec: async () => ({
          exitCode: 0,
          stdout: "MISSING\n",
          stderr: ""
        })
      }
    );
    expect(out).toBeNull();
  });
});
