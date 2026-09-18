import { describe, expect, it, vi } from "vitest";

import { waitForVoiceBridgeHeartbeat } from "@/lib/provisioning/voice-bridge-cutover";

describe("waitForVoiceBridgeHeartbeat", () => {
  it("returns immediately when the heartbeat is already fresh", async () => {
    const getSettings = vi.fn().mockResolvedValue({
      bridge_last_heartbeat_at: new Date().toISOString()
    });
    const remoteExec = vi.fn();
    const result = await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "1936826",
      getSettings,
      remoteExec,
      getSshKey: vi.fn(),
      getVmIp: vi.fn()
    });
    expect(result).toEqual({
      healthy: true,
      heartbeatAt: expect.any(String),
      restarted: false
    });
    expect(remoteExec).not.toHaveBeenCalled();
  });

  it("refuses to SSH when the VM id is not numeric", async () => {
    const result = await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "not-a-vm",
      getSettings: vi.fn().mockResolvedValue({ bridge_last_heartbeat_at: null }),
      remoteExec: vi.fn(),
      getSshKey: vi.fn(),
      getVmIp: vi.fn()
    });
    expect(result.healthy).toBe(false);
    expect(result.restarted).toBe(false);
  });

  it("restarts a stale bridge and polls until the heartbeat is healthy", async () => {
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ bridge_last_heartbeat_at: "2020-01-01T00:00:00.000Z" })
      .mockResolvedValueOnce({ bridge_last_heartbeat_at: new Date().toISOString() });
    const remoteExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const getVmIp = vi.fn().mockResolvedValue("10.0.0.9");
    const getSshKey = vi.fn().mockResolvedValue({
      private_key_pem: "PEM",
      ssh_username: "ubuntu"
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "1936826",
      getSettings,
      remoteExec,
      getVmIp,
      getSshKey,
      sleep,
      timeoutMs: 15_000,
      pollMs: 5_000
    });

    expect(result.healthy).toBe(true);
    expect(result.restarted).toBe(true);
    expect(remoteExec).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "10.0.0.9",
        username: "ubuntu",
        command: expect.stringContaining("docker compose restart voice-bridge")
      })
    );
    expect(sleep).toHaveBeenCalled();
  });

  it("falls back to root when the key has no ssh_username", async () => {
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ bridge_last_heartbeat_at: null })
      .mockResolvedValueOnce({ bridge_last_heartbeat_at: new Date().toISOString() });
    const remoteExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "1001",
      getSettings,
      remoteExec,
      getVmIp: vi.fn().mockResolvedValue("10.0.0.1"),
      getSshKey: vi.fn().mockResolvedValue({ private_key_pem: "PEM", ssh_username: "  " }),
      sleep: vi.fn().mockResolvedValue(undefined),
      timeoutMs: 10_000,
      pollMs: 1
    });
    expect(remoteExec).toHaveBeenCalledWith(expect.objectContaining({ username: "root" }));
  });

  it("skips SSH when IP or key is missing, then times out stale", async () => {
    const nowMs = { t: 0 };
    const result = await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "1001",
      now: () => new Date(nowMs.t),
      sleep: async () => {
        nowMs.t += 10_000;
      },
      getSettings: vi.fn().mockResolvedValue({ bridge_last_heartbeat_at: null }),
      getVmIp: vi.fn().mockResolvedValue(null),
      getSshKey: vi.fn().mockResolvedValue(null),
      remoteExec: vi.fn(),
      timeoutMs: 15_000,
      pollMs: 5_000
    });
    expect(result.healthy).toBe(false);
    expect(result.restarted).toBe(false);
  });

  it("keeps polling after a restart throw and reports stale on timeout", async () => {
    const start = Date.now();
    const nowMs = { t: start };
    const result = await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "1001",
      now: () => new Date(nowMs.t),
      sleep: async () => {
        nowMs.t += 20_000;
      },
      getSettings: vi.fn().mockResolvedValue({
        bridge_last_heartbeat_at: "2020-01-01T00:00:00.000Z"
      }),
      getVmIp: vi.fn().mockResolvedValue("10.0.0.1"),
      getSshKey: vi.fn().mockResolvedValue({ private_key_pem: "PEM" }),
      remoteExec: vi.fn().mockRejectedValue("ssh down"),
      timeoutMs: 15_000,
      pollMs: 5_000
    });
    expect(result.healthy).toBe(false);
    expect(result.restarted).toBe(false);
  });

  it("logs an Error from the restart path the same way as a string throw", async () => {
    const start = Date.now();
    const nowMs = { t: start };
    const result = await waitForVoiceBridgeHeartbeat({
      businessId: "biz-1",
      vpsId: "1001",
      now: () => new Date(nowMs.t),
      sleep: async () => {
        nowMs.t += 20_000;
      },
      getSettings: vi.fn().mockResolvedValue({
        bridge_last_heartbeat_at: "2020-01-01T00:00:00.000Z"
      }),
      getVmIp: vi.fn().mockResolvedValue("10.0.0.1"),
      getSshKey: vi.fn().mockResolvedValue({ private_key_pem: "PEM" }),
      remoteExec: vi.fn().mockRejectedValue(new Error("ssh down")),
      timeoutMs: 15_000,
      pollMs: 5_000
    });
    expect(result.healthy).toBe(false);
  });
});
