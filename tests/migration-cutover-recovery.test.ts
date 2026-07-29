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

  it("recovers via docker probe when exit file is missing", async () => {
    const remoteExec = vi.fn(async (args: { command: string }) => {
      if (args.command.includes("nc-deploy")) {
        return { exitCode: 0, stdout: "MISSING\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "OK\n", stderr: "" };
    });
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
    expect(remoteExec).toHaveBeenCalledTimes(2);
  });

  it("returns null when SSH probes fail and progress is not complete", async () => {
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
          ssh_username: null
        }),
        remoteExec: async () => {
          throw new Error("ssh down");
        }
      }
    );
    expect(out).toBeNull();
  });

  it("returns null when getBusiness throws (Error and string)", async () => {
    const out = await tryRecoverDeployCompleteNewBox(
      { businessId: "biz-1", oldVmId: 100 },
      {
        getBusiness: async () => {
          throw new Error("db down");
        },
        getLatestProvisioningStatus: async () => null,
        getVirtualMachine: async () => ({ ipv4: [] })
      }
    );
    expect(out).toBeNull();

    const out2 = await tryRecoverDeployCompleteNewBox(
      { businessId: "biz-1", oldVmId: 100 },
      {
        getBusiness: async () => {
          throw "biz string fail";
        },
        getLatestProvisioningStatus: async () => null,
        getVirtualMachine: async () => ({ ipv4: [] })
      }
    );
    expect(out2).toBeNull();
  });
});
