import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation(actual.readFileSync)
  };
});

import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import * as fs from "fs";

// Mock all external dependencies
vi.mock("@/lib/hostinger/client", () => {
  class HostingerClient {
    provisionVps = vi.fn().mockResolvedValue({ vpsId: "vps-mock-123" });
    executeCommand = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
  }
  return { HostingerClient };
});

vi.mock("@/lib/inworld/client", () => {
  class InworldClient {
    createVoiceAgent = vi.fn().mockResolvedValue({ agent_id: "inworld-agent-mock" });
  }
  return { InworldClient };
});

vi.mock("@/lib/db/businesses", () => ({
  updateBusinessStatus: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/db/configs", () => ({
  upsertBusinessConfig: vi.fn().mockResolvedValue({}),
  getBusinessConfig: vi.fn().mockResolvedValue(null)
}));

vi.mock("@/lib/twilio/client", () => ({
  readTwilioConfig: vi.fn().mockReturnValue({
    accountSid: "AC_mock",
    authToken: "mock_token",
    messagingServiceSid: "MG_mock"
  }),
  sendOwnerSms: vi.fn().mockResolvedValue({ sid: "SM_mock" })
}));

vi.mock("@/lib/email/client", () => ({
  sendOwnerEmail: vi.fn().mockResolvedValue({ id: "email-mock" })
}));

import { updateBusinessStatus } from "@/lib/db/businesses";
import { upsertBusinessConfig } from "@/lib/db/configs";

describe("provisioning/orchestrate", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      HOSTINGER_API_TOKEN: "mock_hostinger_token",
      INWORLD_API_KEY: "mock_inworld_key",
      ROWBOAT_GATEWAY_TOKEN: "mock_gateway_token",
      RESEND_API_KEY: "mock_resend_key",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000"
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("orchestrateProvisioning returns vpsId, agentId, tunnelUrl", async () => {
    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "owner@test.com"
    });

    expect(result.vpsId).toBe("vps-mock-123");
    expect(result.agentId).toBe("inworld-agent-mock");
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

  it("calls upsertBusinessConfig twice (before and after inworld.ai agent)", async () => {
    await orchestrateProvisioning({ businessId: "biz-uuid-1", tier: "standard" });
    expect(upsertBusinessConfig).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(upsertBusinessConfig).mock.calls[1][0];
    expect(secondCall.inworld_agent_id).toBe("inworld-agent-mock");
  });

  it("deploy command includes INWORLD_AGENT_ID (not ELEVENLABS_AGENT_ID)", async () => {
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
    expect(deployCmd).toContain("INWORLD_AGENT_ID='inworld-agent-mock'");
    expect(deployCmd).not.toContain("ELEVENLABS_AGENT_ID");
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
    expect(deployCmd).toContain("ROWBOAT_GATEWAY_TOKEN='mock_gateway_token'");
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

    expect(mockExec.mock.calls[0][1]).toContain("TIER='starter'");
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
    const { sendOwnerSms } = await import("@/lib/twilio/client");
    vi.mocked(sendOwnerSms).mockRejectedValueOnce(new Error("Twilio error"));

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerPhone: "+15550001111"
    });
    expect(result.agentId).toBe("inworld-agent-mock");
  });

  it("accepts injected deps", async () => {
    const mockHostinger = { provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-injected" }) };
    const mockInworld = { createVoiceAgent: vi.fn().mockResolvedValue({ agent_id: "inworld-injected" }) };

    const result = await orchestrateProvisioning(
      { businessId: "biz-2", tier: "starter" },
      { hostinger: mockHostinger as never, inworld: mockInworld as never }
    );
    expect(result.vpsId).toBe("vps-injected");
    expect(result.agentId).toBe("inworld-injected");
  });

  it("uses fallback empty strings when HOSTINGER_API_TOKEN and INWORLD_API_KEY not set", async () => {
    delete process.env.HOSTINGER_API_TOKEN;
    delete process.env.INWORLD_API_KEY;

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
    expect(result.agentId).toBeTruthy();
  });

  it("hits ROWBOAT_GATEWAY_TOKEN ?? '' and NEXT_PUBLIC_APP_URL ?? fallback branches", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter"
    });
    expect(result.agentId).toBeTruthy();
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
    expect(result.agentId).toBeTruthy();
  });

  it("covers non-Error thrown from SMS notification", async () => {
    const { sendOwnerSms } = await import("@/lib/twilio/client");
    vi.mocked(sendOwnerSms).mockRejectedValueOnce("non-error-sms");

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerPhone: "+15550001111"
    });
    expect(result.agentId).toBeTruthy();
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
    expect(mockExec.mock.calls[0][1]).toContain("BUSINESS_ID='biz-exec'");
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
    expect(mockExec.mock.calls[0][1]).toContain("NOTIFICATIONS_WEBHOOK_TOKEN='webhook-test-token'");
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
    expect(mockExec.mock.calls[0][1]).toContain("NOTIFICATIONS_WEBHOOK_TOKEN='service-key-fallback'");
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
      .mockImplementationOnce(() => { throw new Error("ENOENT: no such file"); })
      .mockImplementationOnce(() => { throw new Error("ENOENT: no such file"); });

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-fallback",
      tier: "starter"
    });
    expect(result.agentId).toBeTruthy();
  });
});
