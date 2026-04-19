import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation(actual.readFileSync)
  };
});

vi.mock("@/lib/provisioning/progress", () => ({
  recordProvisioningProgress: vi.fn().mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000099",
    business_id: "00000000-0000-4000-8000-000000000001",
    task_type: "provisioning",
    status: "thinking",
    log_payload: {}
  })
}));

import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import * as fs from "fs";

vi.mock("@/lib/hostinger/client", () => {
  class HostingerClient {
    provisionVps = vi.fn().mockResolvedValue({ vpsId: "vps-mock-123" });
    executeCommand = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
  }
  return { HostingerClient };
});

vi.mock("@/lib/db/businesses", () => ({
  updateBusinessStatus: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/db/configs", () => ({
  upsertBusinessConfig: vi.fn().mockResolvedValue({}),
  getBusinessConfig: vi.fn().mockResolvedValue(null)
}));

vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn().mockResolvedValue({
    apiKey: "mock_telnyx_key",
    messagingProfileId: "mock_prof"
  }),
  sendTelnyxSms: vi.fn().mockResolvedValue("telnyx-msg-mock")
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn().mockResolvedValue({ id: "email-mock" })
}));

import { updateBusinessStatus } from "@/lib/db/businesses";
import { upsertBusinessConfig } from "@/lib/db/configs";

/** Accepts bash `printf %q` (often unquoted for safe tokens) or legacy `KEY='…'` quoting. */
function expectDeployHasEnv(cmd: string, key: string, value: string): void {
  if (value === "") {
    expect(cmd).toContain(`${key}=''`);
    return;
  }
  const singleQuoted = `'${value.replace(/'/g, "'\\''")}'`;
  expect(
    cmd.includes(`${key}=${singleQuoted}`) || cmd.includes(`${key}=${value}`),
    `expected ${key}=… in command`
  ).toBe(true);
}

describe("provisioning/orchestrate", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      HOSTINGER_API_TOKEN: "mock_hostinger_token",
      ROWBOAT_GATEWAY_TOKEN: "mock_gateway_token",
      RESEND_API_KEY: "mock_resend_key",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock_service_role",
      TELNYX_API_KEY: "mock_telnyx",
      TELNYX_MESSAGING_PROFILE_ID: "mock_prof"
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("orchestrateProvisioning returns vpsId and tunnelUrl", async () => {
    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "owner@test.com"
    });

    expect(result.vpsId).toBe("vps-mock-123");
    expect(result.tunnelUrl).toContain("tunnel.newcoworker.com");
  });

  it("starter tier uses kvm2 VPS plan", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-kvm2" }),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" })
    };

    await orchestrateProvisioning(
      { businessId: "biz-kvm2", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(mockHostinger.provisionVps).toHaveBeenCalledWith("kvm2", "gold-image-starter-v1");
  });

  it("standard tier uses kvm8 VPS plan", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-kvm8" }),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" })
    };

    await orchestrateProvisioning(
      { businessId: "biz-kvm8", tier: "standard" },
      { hostinger: mockHostinger as never }
    );
    expect(mockHostinger.provisionVps).toHaveBeenCalledWith("kvm8", "gold-image-standard-v1");
  });

  it("calls updateBusinessStatus twice (offline then online)", async () => {
    await orchestrateProvisioning({ businessId: "biz-uuid-1", tier: "starter" });
    expect(updateBusinessStatus).toHaveBeenCalledTimes(2);
    expect(updateBusinessStatus).toHaveBeenNthCalledWith(1, "biz-uuid-1", "offline", "vps-mock-123");
    expect(updateBusinessStatus).toHaveBeenNthCalledWith(2, "biz-uuid-1", "online", "vps-mock-123");
  });

  it("calls upsertBusinessConfig without removed Inworld columns", async () => {
    await orchestrateProvisioning({ businessId: "biz-uuid-1", tier: "standard" });
    expect(upsertBusinessConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(upsertBusinessConfig).mock.calls[0][0];
    expect(call).not.toHaveProperty("inworld_agent_id");
  });

  it("uses quoteEnv override for deploy command when injected", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-quote-inject" }),
      executeCommand: mockExec
    };
    await orchestrateProvisioning(
      { businessId: "biz-quote-inject", tier: "starter" },
      {
        hostinger: mockHostinger as never,
        quoteEnv: (v) => `<<${v}>>`
      }
    );
    const cmd = mockExec.mock.calls[0][1] as string;
    expect(cmd).toContain("BUSINESS_ID=<<biz-quote-inject>>");
  });

  it("deploy command allows empty optional Telnyx and Supabase keys", async () => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_MESSAGING_PROFILE_ID;
    delete process.env.TELNYX_SMS_FROM_E164;
    delete process.env.STREAM_URL_SIGNING_SECRET;
    delete process.env.BRIDGE_MEDIA_WSS_ORIGIN;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_LIVE_MODEL;
    delete process.env.GEMINI_LIVE_ENABLED;
    delete process.env.VOICE_BRIDGE_SRC;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-empty" }),
      executeCommand: mockExec
    };
    await orchestrateProvisioning(
      { businessId: "biz-empty-env", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    const cmd = mockExec.mock.calls[0][1] as string;
    expect(cmd).toContain("TELNYX_API_KEY=''");
    expect(cmd).toContain("TELNYX_MESSAGING_PROFILE_ID=''");
    expect(cmd).toContain("TELNYX_SMS_FROM_E164=''");
    expect(cmd).toContain("STREAM_URL_SIGNING_SECRET=''");
    expect(cmd).toContain("BRIDGE_MEDIA_WSS_ORIGIN=''");
    expect(cmd).toContain("GOOGLE_API_KEY=''");
    expect(cmd).toContain("GEMINI_LIVE_MODEL=''");
    expect(cmd).toContain("GEMINI_LIVE_ENABLED=''");
    expect(cmd).toContain("VOICE_BRIDGE_SRC=''");
    expect(cmd).toContain("SUPABASE_SERVICE_KEY=''");
  });

  it("deploy command forwards voice-bridge env (GOOGLE_API_KEY / GEMINI_LIVE_MODEL / GEMINI_LIVE_ENABLED / VOICE_BRIDGE_SRC) when set", async () => {
    process.env.GOOGLE_API_KEY = "sk-live-abc";
    process.env.GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
    process.env.GEMINI_LIVE_ENABLED = "false";
    process.env.VOICE_BRIDGE_SRC = "/opt/newcoworker-repo/vps/voice-bridge";
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-bridge" }),
      executeCommand: mockExec
    };
    await orchestrateProvisioning(
      { businessId: "biz-bridge", tier: "standard" },
      { hostinger: mockHostinger as never }
    );
    const cmd = mockExec.mock.calls[0][1] as string;
    expectDeployHasEnv(cmd, "GOOGLE_API_KEY", "sk-live-abc");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_ENABLED", "false");
    expectDeployHasEnv(cmd, "VOICE_BRIDGE_SRC", "/opt/newcoworker-repo/vps/voice-bridge");
  });

  it("deploy command includes Telnyx env vars (not INWORLD)", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-env" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-env", tier: "starter" },
      { hostinger: mockHostinger as never }
    );

    const deployCmd = mockExec.mock.calls[0][1] as string;
    expectDeployHasEnv(deployCmd, "TELNYX_API_KEY", "mock_telnyx");
    expectDeployHasEnv(deployCmd, "TELNYX_MESSAGING_PROFILE_ID", "mock_prof");
    expect(deployCmd).not.toContain("INWORLD_AGENT_ID");
  });

  it("deploy command includes ROWBOAT_GATEWAY_TOKEN (not OPENCLAW)", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-env2" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-env2", tier: "starter" },
      { hostinger: mockHostinger as never }
    );

    const deployCmd = mockExec.mock.calls[0][1] as string;
    expectDeployHasEnv(deployCmd, "ROWBOAT_GATEWAY_TOKEN", "mock_gateway_token");
    expect(deployCmd).not.toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  it("deploy command includes TIER variable", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-tier" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-tier", tier: "starter" },
      { hostinger: mockHostinger as never }
    );

    expectDeployHasEnv(mockExec.mock.calls[0][1] as string, "TIER", "starter");
  });

  it("continues even when email notification fails", async () => {
    const { sendOwnerEmail } = await import("@/lib/email/client");
    vi.mocked(sendOwnerEmail).mockRejectedValueOnce(new Error("SMTP error"));

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "owner@test.com"
    });
    expect(result.vpsId).toBe("vps-mock-123");
  });

  it("continues even when SMS notification fails", async () => {
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    vi.mocked(sendTelnyxSms).mockRejectedValueOnce(new Error("Telnyx error"));

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerPhone: "+15550001111"
    });
    expect(result.vpsId).toBe("vps-mock-123");
  });

  it("accepts injected hostinger", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-injected" }),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" })
    };

    const result = await orchestrateProvisioning(
      { businessId: "biz-2", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(result.vpsId).toBe("vps-injected");
  });

  it("uses fallback empty strings when HOSTINGER_API_TOKEN not set", async () => {
    delete process.env.HOSTINGER_API_TOKEN;

    const result = await orchestrateProvisioning({
      businessId: "biz-env-test",
      tier: "starter"
    });
    expect(result.vpsId).toBe("vps-mock-123");
  });

  it("hits RESEND_API_KEY ?? empty string branch when key not set but ownerEmail is provided", async () => {
    delete process.env.RESEND_API_KEY;

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "direct@test.com"
    });
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("hits ROWBOAT_GATEWAY_TOKEN ?? '' and NEXT_PUBLIC_APP_URL ?? fallback branches", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter"
    });
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("falls back SUPABASE_URL to empty string in deploy command when unset", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-no-supabase-url" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-no-supabase-url", tier: "starter" },
      { hostinger: mockHostinger as never }
    );

    expect(mockExec.mock.calls[0][1]).toContain("SUPABASE_URL=''");
  });

  it("covers non-Error thrown from email notification", async () => {
    const { sendOwnerEmail } = await import("@/lib/email/client");
    vi.mocked(sendOwnerEmail).mockRejectedValueOnce("non-error-string");

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "owner@test.com"
    });
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("covers non-Error thrown from SMS notification", async () => {
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    vi.mocked(sendTelnyxSms).mockRejectedValueOnce("non-error-sms");

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerPhone: "+15550001111"
    });
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("calls executeCommand on VPS after provisioning", async () => {
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-exec-123" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-exec", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toBe("vps-exec-123");
    const execCmd = mockExec.mock.calls[0][1] as string;
    expectDeployHasEnv(execCmd, "BUSINESS_ID", "biz-exec");
    expectDeployHasEnv(
      execCmd,
      "PROVISIONING_PROGRESS_URL",
      "http://localhost:3000/api/provisioning/progress"
    );
    expectDeployHasEnv(execCmd, "PROVISIONING_PROGRESS_TOKEN", "mock_gateway_token");
  });

  it("continues when executeCommand returns non-zero exit", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-nz" }),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, output: "deploy failed" })
    };

    const result = await orchestrateProvisioning(
      { businessId: "biz-fail-exec", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(result.vpsId).toBe("vps-nz");
  });

  it("records deploy failure when executeCommand returns non-zero with undefined output", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-out" }),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, output: undefined })
    };
    const result = await orchestrateProvisioning(
      { businessId: "biz-undef-out", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(result.vpsId).toBe("vps-out");
  });

  it("continues when executeCommand throws", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-throw" }),
      executeCommand: vi.fn().mockRejectedValue("network error")
    };

    const result = await orchestrateProvisioning(
      { businessId: "biz-throw-exec", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(result.vpsId).toBe("vps-throw");
  });

  it("continues when executeCommand throws an Error instance", async () => {
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-err" }),
      executeCommand: vi.fn().mockRejectedValue(new Error("SSH timeout"))
    };

    const result = await orchestrateProvisioning(
      { businessId: "biz-err-exec", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expect(result.vpsId).toBe("vps-err");
  });

  it("passes NOTIFICATIONS_WEBHOOK_TOKEN env to deploy command", async () => {
    process.env.NOTIFICATIONS_WEBHOOK_TOKEN = "webhook-test-token";
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-tok" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-token-test", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expectDeployHasEnv(mockExec.mock.calls[0][1] as string, "NOTIFICATIONS_WEBHOOK_TOKEN", "webhook-test-token");
  });

  it("falls back NOTIFICATIONS_WEBHOOK_TOKEN to SUPABASE_SERVICE_ROLE_KEY", async () => {
    delete process.env.NOTIFICATIONS_WEBHOOK_TOKEN;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-fallback";
    const mockExec = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const mockHostinger = {
      provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-fb" }),
      executeCommand: mockExec
    };

    await orchestrateProvisioning(
      { businessId: "biz-fallback", tier: "starter" },
      { hostinger: mockHostinger as never }
    );
    expectDeployHasEnv(
      mockExec.mock.calls[0][1] as string,
      "NOTIFICATIONS_WEBHOOK_TOKEN",
      "service-key-fallback"
    );
  });

  it("throws for enterprise tier — requires custom engagement", async () => {
    await expect(
      orchestrateProvisioning({ businessId: "biz-enterprise", tier: "enterprise" })
    ).rejects.toThrow("Enterprise provisioning requires a custom engagement");
  });

  it("throws for enterprise tier with CONTACT_EMAIL from env", async () => {
    process.env.CONTACT_EMAIL = "custom@example.com";
    await expect(
      orchestrateProvisioning({ businessId: "biz-enterprise-2", tier: "enterprise" })
    ).rejects.toThrow("custom@example.com");
  });

  it("throws for enterprise tier using fallback email when CONTACT_EMAIL unset", async () => {
    delete process.env.CONTACT_EMAIL;
    await expect(
      orchestrateProvisioning({ businessId: "biz-enterprise-3", tier: "enterprise" })
    ).rejects.toThrow("newcoworkerteam@gmail.com");
  });

  it("loads default soul/identity templates when readFileSync throws", async () => {
    vi.mocked(fs.readFileSync)
      .mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file");
      })
      .mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file");
      });

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-fallback",
      tier: "starter"
    });
    expect(result.tunnelUrl).toBeTruthy();
  });
});
