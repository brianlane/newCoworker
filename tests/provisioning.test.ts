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
  }
  return { HostingerClient };
});

vi.mock("@/lib/elevenlabs/client", () => {
  class ElevenLabsClient {
    createSecret = vi.fn().mockResolvedValue({ secret_id: "secret-mock" });
    createAgent = vi.fn().mockResolvedValue({ agent_id: "el-agent-mock" });
  }
  return { ElevenLabsClient };
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
      ELEVENLABS_API_KEY: "mock_elevenlabs_key",
      OPENCLAW_GATEWAY_TOKEN: "mock_gateway_token",
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
    expect(result.agentId).toBe("el-agent-mock");
    expect(result.tunnelUrl).toContain("tunnel.newcoworker.com");
  });

  it("calls updateBusinessStatus twice (offline then online)", async () => {
    await orchestrateProvisioning({ businessId: "biz-uuid-1", tier: "starter" });
    expect(updateBusinessStatus).toHaveBeenCalledTimes(2);
    expect(updateBusinessStatus).toHaveBeenNthCalledWith(1, "biz-uuid-1", "offline", "vps-mock-123");
    expect(updateBusinessStatus).toHaveBeenNthCalledWith(2, "biz-uuid-1", "online", "vps-mock-123");
  });

  it("calls upsertBusinessConfig twice (before and after ElevenLabs)", async () => {
    await orchestrateProvisioning({ businessId: "biz-uuid-1", tier: "standard" });
    expect(upsertBusinessConfig).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(upsertBusinessConfig).mock.calls[1][0];
    expect(secondCall.elevenlabs_agent_id).toBe("el-agent-mock");
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
    expect(result.agentId).toBe("el-agent-mock");
  });

  it("accepts injected deps", async () => {
    const mockHostinger = { provisionVps: vi.fn().mockResolvedValue({ vpsId: "vps-injected" }) };
    const mockElevenlabs = {
      createSecret: vi.fn().mockResolvedValue({ secret_id: "s" }),
      createAgent: vi.fn().mockResolvedValue({ agent_id: "el-injected" })
    };

    const result = await orchestrateProvisioning(
      { businessId: "biz-2", tier: "starter" },
      { hostinger: mockHostinger as never, elevenlabs: mockElevenlabs as never }
    );
    expect(result.vpsId).toBe("vps-injected");
    expect(result.agentId).toBe("el-injected");
  });

  it("uses fallback empty strings when HOSTINGER_API_TOKEN and ELEVENLABS_API_KEY not set (no injected deps)", async () => {
    // Remove env vars to hit ?? "" branches on lines 56 and 81
    // Also do NOT inject deps so the constructors are actually called
    delete process.env.HOSTINGER_API_TOKEN;
    delete process.env.ELEVENLABS_API_KEY;

    // No deps injected — HostingerClient and ElevenLabsClient constructors are called
    const result = await orchestrateProvisioning({
      businessId: "biz-env-test",
      tier: "starter"
    });
    expect(result.vpsId).toBe("vps-mock-123"); // from class mock
  });

  it("hits RESEND_API_KEY ?? empty string branch when key not set but ownerEmail is provided", async () => {
    delete process.env.RESEND_API_KEY;

    // ownerEmail provided explicitly so the if(notifyEmail) block is entered
    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "direct@test.com"
    });
    expect(result.agentId).toBeTruthy();
  });

  it("hits OPENCLAW_GATEWAY_TOKEN ?? '' and NEXT_PUBLIC_APP_URL ?? fallback branches", async () => {
    // Remove these env vars to hit both ?? fallback branches
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter"
    });
    expect(result.agentId).toBeTruthy();
  });

  it("covers non-Error thrown from email notification (err instanceof Error false branch)", async () => {
    const { sendOwnerEmail } = await import("@/lib/email/client");
    vi.mocked(sendOwnerEmail).mockRejectedValueOnce("non-error-string");

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerEmail: "owner@test.com"
    });
    expect(result.agentId).toBeTruthy();
  });

  it("covers non-Error thrown from SMS notification (err instanceof Error false branch)", async () => {
    const { sendOwnerSms } = await import("@/lib/twilio/client");
    vi.mocked(sendOwnerSms).mockRejectedValueOnce("non-error-sms");

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-1",
      tier: "starter",
      ownerPhone: "+15550001111"
    });
    expect(result.agentId).toBeTruthy();
  });

  it("loads default soul/identity templates when readFileSync throws (covers catch blocks)", async () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file");
    }).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file");
    });

    const result = await orchestrateProvisioning({
      businessId: "biz-uuid-fallback",
      tier: "starter"
    });
    expect(result.agentId).toBeTruthy();
  });
});
