import { describe, it, expect, vi } from "vitest";
import {
  waitForDetachedDeployClient,
  runDetachedDeployClient,
  DEPLOY_CLIENT_LOCK_BUSY_EXIT
} from "@/lib/provisioning/orchestrate";
import type { SshExecResult } from "@/lib/hostinger/ssh";

function ok(stdout = "0\nSTOPPED"): SshExecResult {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

describe("waitForDetachedDeployClient", () => {
  it("succeeds when progress phase is deploy_client_complete", async () => {
    const remoteExec = vi.fn();
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec,
      latestProvisioningStatus: async () => ({
        percent: 100,
        phase: "deploy_client_complete",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => 0,
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "progress" });
    expect(remoteExec).not.toHaveBeenCalled();
  });

  it("succeeds when exit file is 0", async () => {
    let tick = 0;
    const remoteExec = vi.fn(async () => ok("0\nSTOPPED"));
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec,
      latestProvisioningStatus: async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => (tick++ === 0 ? 0 : 1),
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "exit_file" });
    expect(remoteExec).toHaveBeenCalled();
  });

  it("fails when exit file is non-zero", async () => {
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(async () => ok("7\nSTOPPED")),
      latestProvisioningStatus: async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => 0,
      deadlineMs: 60_000
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(7);
      expect(result.reason).toContain("exit 7");
    }
  });

  it("fails when progress phase is deploy_client_failed", async () => {
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(),
      latestProvisioningStatus: async () => ({
        percent: 95,
        phase: "deploy_client_failed",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "error"
      }),
      sleep: async () => undefined,
      now: () => 0,
      deadlineMs: 60_000
    });
    expect(result).toEqual({
      ok: false,
      reason: "deploy_client_failed",
      exitCode: undefined
    });
  });

  it("ignores a numeric exit file while the deploy PID is still RUNNING", async () => {
    let polls = 0;
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(async () => ok("0\nRUNNING")),
      latestProvisioningStatus: async () => {
        polls += 1;
        if (polls >= 3) {
          return {
            percent: 100,
            phase: "deploy_client_complete",
            updatedAt: "2026-01-01T00:00:00.000Z",
            logStatus: "thinking"
          };
        }
        return {
          percent: 40,
          phase: "remote_deploy_starting",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "thinking"
        };
      },
      sleep: async () => undefined,
      now: () => polls * 1000,
      pollIntervalMs: 1,
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "progress" });
  });

  it("ignores null probe stdout and keeps polling until progress completes", async () => {
    let polls = 0;
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        stdout: undefined as unknown as string,
        stderr: ""
      })),
      latestProvisioningStatus: async () => {
        polls += 1;
        if (polls >= 2) {
          return {
            percent: 100,
            phase: "deploy_client_complete",
            updatedAt: "2026-01-01T00:00:00.000Z",
            logStatus: "thinking"
          };
        }
        return {
          percent: 40,
          phase: "remote_deploy_starting",
          updatedAt: "2026-01-01T00:00:00.000Z",
          logStatus: "thinking"
        };
      },
      sleep: async () => undefined,
      now: () => polls * 1000,
      pollIntervalMs: 1,
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "progress" });
  });

  it("attaches without starting when envVars omit BUSINESS_ID", async () => {
    const remoteExec = vi.fn(async () => ok("0\nSTOPPED"));
    const result = await runDetachedDeployClient({
      businessId: "biz-1",
      envVars: "",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec,
      latestProvisioningStatus: async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => 0,
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "exit_file" });
    expect(remoteExec.mock.calls.every((c) => !String(c[0].command).includes("nohup"))).toBe(
      true
    );
  });

  it("fails when deadline elapses", async () => {
    let t = 0;
    const result = await waitForDetachedDeployClient({
      businessId: "biz-1",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(async () => ok("MISSING\nRUNNING")),
      latestProvisioningStatus: async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => {
        const cur = t;
        t += 100_000;
        return cur;
      },
      pollIntervalMs: 1,
      deadlineMs: 50_000
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/did not finish/);
  });
});

describe("runDetachedDeployClient", () => {
  it("starts a fresh deploy when flock is free (exit 0) and polls to success", async () => {
    const remoteExec = vi.fn(async (args: { command: string }) => {
      if (args.command.includes("flock -n")) {
        return { exitCode: 0, signal: null, stdout: "12345\n", stderr: "" };
      }
      return ok("0\nSTOPPED");
    });
    const result = await runDetachedDeployClient({
      businessId: "biz-1",
      envVars: "BUSINESS_ID='biz-1' TIER=starter",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec,
      latestProvisioningStatus: async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => 0,
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "exit_file" });
  });

  it("attaches when flock is busy (exit 75) and polls to success", async () => {
    const remoteExec = vi.fn(async (args: { command: string }) => {
      if (args.command.includes("flock -n")) {
        return {
          exitCode: DEPLOY_CLIENT_LOCK_BUSY_EXIT,
          signal: null,
          stdout: "",
          stderr: "busy"
        };
      }
      return ok("0\nSTOPPED");
    });
    const result = await runDetachedDeployClient({
      businessId: "biz-1",
      envVars: "BUSINESS_ID='biz-1' TIER=starter",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec,
      latestProvisioningStatus: async () => ({
        percent: 40,
        phase: "remote_deploy_starting",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logStatus: "thinking"
      }),
      sleep: async () => undefined,
      now: () => 0,
      deadlineMs: 60_000
    });
    expect(result).toEqual({ ok: true, source: "exit_file" });
  });

  it("returns start failure when remoteExec throws", async () => {
    const result = await runDetachedDeployClient({
      businessId: "biz-1",
      envVars: "BUSINESS_ID='biz-1' TIER=starter",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(async () => {
        throw new Error("ssh down");
      }),
      latestProvisioningStatus: async () => null,
      sleep: async () => undefined,
      now: () => 0
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ssh down/);
  });

  it("fails immediately when start exits non-zero (not 75)", async () => {
    const result = await runDetachedDeployClient({
      businessId: "biz-1",
      envVars: "BUSINESS_ID='biz-1' TIER=starter",
      host: "1.2.3.4",
      username: "root",
      privateKeyPem: "PEM",
      remoteExec: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "boom"
      })),
      latestProvisioningStatus: async () => null,
      sleep: async () => undefined,
      now: () => 0
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/failed to start/);
  });
});
