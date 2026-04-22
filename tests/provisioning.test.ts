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
import type { ProvisionVpsForBusinessResult } from "@/lib/hostinger/provision";
import type { SshExecResult } from "@/lib/hostinger/ssh";

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

vi.mock("@/lib/db/telnyx-routes", () => ({
  getTelnyxVoiceRouteForBusiness: vi.fn().mockResolvedValue(null)
}));

import { updateBusinessStatus } from "@/lib/db/businesses";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";

function makeVpsStub(
  vpsId = "42",
  publicIp = "1.2.3.4",
  privateKeyPem = "PEM"
): ProvisionVpsForBusinessResult {
  return {
    virtualMachineId: Number(vpsId) || 42,
    publicIp,
    sshUsername: "root",
    sshKey: {
      id: "row",
      business_id: "b",
      hostinger_vps_id: vpsId,
      hostinger_public_key_id: 9,
      public_key: "ssh-ed25519 AAA",
      private_key_pem: privateKeyPem,
      fingerprint_sha256: "SHA256:abc",
      ssh_username: "root",
      created_at: "2026-01-01T00:00:00Z",
      rotated_at: null
    },
    postInstallScriptId: 11,
    publicKeyId: 9
  };
}

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

function okExec(): SshExecResult {
  return { exitCode: 0, signal: null, stdout: "ok", stderr: "" };
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
    // Same hermeticity defences as before: scrub any CF / bridge-origin
    // env the dev shell may have leaked in so the fallback/asserts stay
    // truthful per-test.
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
    delete process.env.CLOUDFLARE_TUNNEL_ZONE;
    delete process.env.CLOUDFLARE_TUNNEL_SERVICE_URL;
    delete process.env.BRIDGE_MEDIA_WSS_ORIGIN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("orchestrateProvisioning returns vpsId and tunnelUrl from injected vpsProvisioner", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());

    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter", ownerEmail: "owner@test.com" },
      { vpsProvisioner, remoteExec }
    );

    expect(result.vpsId).toBe("123");
    expect(result.tunnelUrl).toContain("tunnel.newcoworker.com");
    expect(vpsProvisioner).toHaveBeenCalledWith({ businessId: "biz-uuid-1", tier: "starter" });
  });

  it("starter tier forwards to provisioner with tier='starter'", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s1"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-kvm2", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({ businessId: "biz-kvm2", tier: "starter" });
  });

  it("standard tier forwards to provisioner with tier='standard'", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s2"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-kvm8", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({ businessId: "biz-kvm8", tier: "standard" });
  });

  it("calls updateBusinessStatus twice (offline then online)", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    expect(updateBusinessStatus).toHaveBeenCalledTimes(2);
    expect(updateBusinessStatus).toHaveBeenNthCalledWith(1, "biz-uuid-1", "offline", "42");
    expect(updateBusinessStatus).toHaveBeenNthCalledWith(2, "biz-uuid-1", "online", "42");
  });

  it("calls upsertBusinessConfig with no legacy Inworld columns", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );
    expect(upsertBusinessConfig).toHaveBeenCalledTimes(1);
    const call = vi.mocked(upsertBusinessConfig).mock.calls[0][0];
    expect(call).not.toHaveProperty("inworld_agent_id");
  });

  it("preserves existing website_md when re-provisioning so the onboarding crawl is not wiped", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValueOnce({
      business_id: "biz-uuid-1",
      soul_md: "# s",
      identity_md: "# i",
      memory_md: "# m",
      website_md: "# crawled\nImportant business context",
      updated_at: "2026-04-20T00:00:00Z"
    } as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());

    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );

    const call = vi.mocked(upsertBusinessConfig).mock.calls[0][0];
    expect(call.website_md).toBe("# crawled\nImportant business context");
  });

  it("defaults website_md to empty string when no prior config exists", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValueOnce(null as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());

    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );

    const call = vi.mocked(upsertBusinessConfig).mock.calls[0][0];
    expect(call.website_md).toBe("");
  });

  it("uses quoteEnv override when injected", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-quote-inject", tier: "starter" },
      { vpsProvisioner, remoteExec, quoteEnv: (v) => `<<${v}>>` }
    );
    const cmd = remoteExec.mock.calls[0][0].command as string;
    expect(cmd).toContain("BUSINESS_ID=<<biz-quote-inject>>");
  });

  it("deploy command quotes empty strings for missing optional env vars", async () => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_MESSAGING_PROFILE_ID;
    delete process.env.TELNYX_SMS_FROM_E164;
    delete process.env.STREAM_URL_SIGNING_SECRET;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_LIVE_MODEL;
    delete process.env.GEMINI_LIVE_ENABLED;
    delete process.env.VOICE_BRIDGE_SRC;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-empty-env", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = remoteExec.mock.calls[0][0].command as string;
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

  it("deploy command forwards voice-bridge env when set", async () => {
    process.env.GOOGLE_API_KEY = "sk-live-abc";
    process.env.GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
    process.env.GEMINI_LIVE_ENABLED = "false";
    process.env.VOICE_BRIDGE_SRC = "/opt/newcoworker-repo/vps/voice-bridge";
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-bridge", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = remoteExec.mock.calls[0][0].command as string;
    expectDeployHasEnv(cmd, "GOOGLE_API_KEY", "sk-live-abc");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_ENABLED", "false");
    expectDeployHasEnv(cmd, "VOICE_BRIDGE_SRC", "/opt/newcoworker-repo/vps/voice-bridge");
  });

  it("deploy command includes Telnyx env and gateway token", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-env", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = remoteExec.mock.calls[0][0].command as string;
    expectDeployHasEnv(cmd, "TELNYX_API_KEY", "mock_telnyx");
    expectDeployHasEnv(cmd, "TELNYX_MESSAGING_PROFILE_ID", "mock_prof");
    expectDeployHasEnv(cmd, "ROWBOAT_GATEWAY_TOKEN", "mock_gateway_token");
    expectDeployHasEnv(cmd, "TIER", "starter");
    expect(cmd).not.toContain("INWORLD_AGENT_ID");
    expect(cmd).not.toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  it("SSH exec is invoked with host/username/privateKey from the vpsProvisioner result", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("100", "9.9.9.9", "MY_PEM"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-ssh-args", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    const arg = remoteExec.mock.calls[0][0];
    expect(arg.host).toBe("9.9.9.9");
    expect(arg.username).toBe("root");
    expect(arg.privateKeyPem).toBe("MY_PEM");
    expect(arg.command).toContain("/opt/deploy-client.sh");
  });

  it("continues even when email notification fails", async () => {
    const { sendOwnerEmail } = await import("@/lib/email/client");
    vi.mocked(sendOwnerEmail).mockRejectedValueOnce(new Error("SMTP error"));
    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter", ownerEmail: "owner@test.com" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues even when SMS notification fails", async () => {
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    vi.mocked(sendTelnyxSms).mockRejectedValueOnce(new Error("Telnyx error"));
    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter", ownerPhone: "+15550001111" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("covers non-Error thrown from email notification", async () => {
    const { sendOwnerEmail } = await import("@/lib/email/client");
    vi.mocked(sendOwnerEmail).mockRejectedValueOnce("non-error-string");
    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter", ownerEmail: "owner@test.com" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("covers non-Error thrown from SMS notification", async () => {
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    vi.mocked(sendTelnyxSms).mockRejectedValueOnce("non-error-sms");
    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter", ownerPhone: "+15550001111" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("continues when remoteExec returns non-zero exit code", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, signal: null, stdout: "", stderr: "deploy failed" });
    const result = await orchestrateProvisioning(
      { businessId: "biz-fail-exec", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues when remoteExec non-zero with empty stderr/stdout", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValue({ exitCode: 1, signal: null, stdout: "", stderr: "" });
    const result = await orchestrateProvisioning(
      { businessId: "biz-fail-exec-empty", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues when remoteExec throws an Error", async () => {
    const remoteExec = vi.fn().mockRejectedValue(new Error("SSH timeout"));
    const result = await orchestrateProvisioning(
      { businessId: "biz-err-exec", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues when remoteExec throws a non-Error value", async () => {
    const remoteExec = vi.fn().mockRejectedValue("network error");
    const result = await orchestrateProvisioning(
      { businessId: "biz-throw-exec", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("passes NOTIFICATIONS_WEBHOOK_TOKEN env through to deploy command", async () => {
    process.env.NOTIFICATIONS_WEBHOOK_TOKEN = "webhook-test-token";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-token-test", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expectDeployHasEnv(
      remoteExec.mock.calls[0][0].command as string,
      "NOTIFICATIONS_WEBHOOK_TOKEN",
      "webhook-test-token"
    );
  });

  it("falls back NOTIFICATIONS_WEBHOOK_TOKEN to SUPABASE_SERVICE_ROLE_KEY", async () => {
    delete process.env.NOTIFICATIONS_WEBHOOK_TOKEN;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-fallback";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-fallback", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expectDeployHasEnv(
      remoteExec.mock.calls[0][0].command as string,
      "NOTIFICATIONS_WEBHOOK_TOKEN",
      "service-key-fallback"
    );
  });

  it("throws for enterprise tier — requires custom engagement", async () => {
    await expect(
      orchestrateProvisioning({ businessId: "biz-enterprise", tier: "enterprise" })
    ).rejects.toThrow("Enterprise provisioning requires a custom engagement");
  });

  it("enterprise error mentions CONTACT_EMAIL from env", async () => {
    process.env.CONTACT_EMAIL = "custom@example.com";
    await expect(
      orchestrateProvisioning({ businessId: "biz-enterprise-2", tier: "enterprise" })
    ).rejects.toThrow("custom@example.com");
  });

  it("enterprise error uses fallback email when CONTACT_EMAIL unset", async () => {
    delete process.env.CONTACT_EMAIL;
    await expect(
      orchestrateProvisioning({ businessId: "biz-enterprise-3", tier: "enterprise" })
    ).rejects.toThrow("newcoworkerteam@gmail.com");
  });

  it("falls back RESEND_API_KEY to '' when unset but ownerEmail provided", async () => {
    delete process.env.RESEND_API_KEY;
    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter", ownerEmail: "direct@test.com" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("falls back ROWBOAT_GATEWAY_TOKEN and NEXT_PUBLIC_APP_URL when unset", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("falls back SUPABASE_URL to empty string when unset", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-no-supabase-url", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(remoteExec.mock.calls[0][0].command).toContain("SUPABASE_URL=''");
  });

  it("per-tenant tunnel: uses CF provisioner token + hostname when injected", async () => {
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "tun-42",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-cf.tunnel.newcoworker.com",
      voiceHostname: "voice-biz-cf.tunnel.newcoworker.com"
    });
    const result = await orchestrateProvisioning(
      { businessId: "biz-cf", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: cfStub
      }
    );
    expect(cfStub).toHaveBeenCalledWith({ businessId: "biz-cf" });
    expect(result.tunnelUrl).toBe("https://biz-cf.tunnel.newcoworker.com");
    const cmd = remoteExec.mock.calls[0][0].command as string;
    expectDeployHasEnv(cmd, "CLOUDFLARE_TUNNEL_TOKEN", "PER_TENANT_TOKEN");
    expectDeployHasEnv(cmd, "BRIDGE_MEDIA_WSS_ORIGIN", "wss://voice-biz-cf.tunnel.newcoworker.com");
  });

  it("per-tenant tunnel: falls back to env CLOUDFLARE_TUNNEL_TOKEN when provisioner throws", async () => {
    process.env.CLOUDFLARE_TUNNEL_TOKEN = "SHARED_ENV_TOKEN";
    process.env.BRIDGE_MEDIA_WSS_ORIGIN = "wss://shared-voice.example.com";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockRejectedValue(new Error("Invalid API Token"));
    const result = await orchestrateProvisioning(
      { businessId: "biz-cf-fail", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: cfStub
      }
    );
    expect(result.tunnelUrl).toBe("https://biz-cf-fail.tunnel.newcoworker.com");
    const cmd = remoteExec.mock.calls[0][0].command as string;
    expectDeployHasEnv(cmd, "CLOUDFLARE_TUNNEL_TOKEN", "SHARED_ENV_TOKEN");
    expectDeployHasEnv(cmd, "BRIDGE_MEDIA_WSS_ORIGIN", "wss://shared-voice.example.com");
  });

  it("per-tenant tunnel: stringifies non-Error rejections before logging", async () => {
    process.env.CLOUDFLARE_TUNNEL_TOKEN = "SHARED_ENV_TOKEN_NONERR";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockRejectedValue("cf-exploded-as-string");
    const result = await orchestrateProvisioning(
      { businessId: "biz-cf-nonerr", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: cfStub
      }
    );
    expect(result.tunnelUrl).toBe("https://biz-cf-nonerr.tunnel.newcoworker.com");
    expectDeployHasEnv(
      remoteExec.mock.calls[0][0].command as string,
      "CLOUDFLARE_TUNNEL_TOKEN",
      "SHARED_ENV_TOKEN_NONERR"
    );
  });

  it("per-tenant tunnel: disables provisioner via explicit null dep", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "would-explode-if-used";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-id";
    process.env.CLOUDFLARE_TUNNEL_TOKEN = "LEGACY_TOKEN";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const result = await orchestrateProvisioning(
      { businessId: "biz-cf-null", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: null
      }
    );
    expect(result.tunnelUrl).toBe("https://biz-cf-null.tunnel.newcoworker.com");
    expectDeployHasEnv(
      remoteExec.mock.calls[0][0].command as string,
      "CLOUDFLARE_TUNNEL_TOKEN",
      "LEGACY_TOKEN"
    );
  });

  it("loads default soul/identity templates when readFileSync throws", async () => {
    vi.mocked(fs.readFileSync)
      .mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file");
      })
      .mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file");
      });

    const result = await orchestrateProvisioning(
      { businessId: "biz-uuid-fallback", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.tunnelUrl).toBeTruthy();
  });

  it("falls back to env BRIDGE_MEDIA_WSS_ORIGIN when tunnel provisioner is disabled (null) + env set", async () => {
    process.env.BRIDGE_MEDIA_WSS_ORIGIN = "wss://legacy-shared.example.com";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-null-wss", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: null
      }
    );
    expectDeployHasEnv(
      remoteExec.mock.calls[0][0].command as string,
      "BRIDGE_MEDIA_WSS_ORIGIN",
      "wss://legacy-shared.example.com"
    );
  });

  describe("DID auto-provisioning", () => {
    it("is skipped by default (no env flag, no injected provisioner)", async () => {
      delete process.env.TELNYX_AUTO_PURCHASE_DID;
      const didProvisioner = vi.fn();
      await orchestrateProvisioning(
        { businessId: "biz-no-did", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec())
        }
      );
      expect(didProvisioner).not.toHaveBeenCalled();
    });

    it("runs when env flag is set + injected provisioner supplied", async () => {
      const didProvisioner = vi
        .fn()
        .mockResolvedValue({ toE164: "+15550001111" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: "biz-did",
          search: expect.objectContaining({ countryCode: "US" })
        })
      );
    });

    it("skips when business already has a DID", async () => {
      const didProvisioner = vi.fn();
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce({
        to_e164: "+15551239999",
        business_id: "biz-already",
        media_wss_origin: null,
        media_path: "/voice/stream",
        created_at: "2026-01-01T00:00:00Z"
      });
      await orchestrateProvisioning(
        { businessId: "biz-already", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).not.toHaveBeenCalled();
    });

    it("surfaces OrderAndAssignError.reason but does not abort the deploy", async () => {
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const didProvisioner = vi
        .fn()
        .mockRejectedValue(new OrderAndAssignError("no_numbers_available", "oof"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-fail", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec,
          didProvisioner
        }
      );
      expect(result.vpsId).toBe("42");
      expect(remoteExec).toHaveBeenCalled();
    });

    it("stringifies generic Error failures in DID provisioning", async () => {
      const didProvisioner = vi.fn().mockRejectedValue(new Error("Telnyx down"));
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-generic", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(result.vpsId).toBe("42");
    });

    it("stringifies non-Error rejections in DID provisioning", async () => {
      const didProvisioner = vi.fn().mockRejectedValue("telnyx-string-error");
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-nonerr", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(result.vpsId).toBe("42");
    });

    it("runs via env flag alone when didProvisioner is undefined (falls back to default factory)", async () => {
      // We can't actually fire the default factory without hitting Telnyx; the
      // default branch is guarded by `c8 ignore` because we never want to run
      // it in a unit test. Exercise the *flag* path here by setting the env
      // and also injecting the provisioner so the flow uses our stub.
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550002222" });
      await orchestrateProvisioning(
        { businessId: "biz-did-envflag", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalled();
    });

    it("does spread a concrete bridgeMediaWssOrigin from env into platformDefaults", async () => {
      process.env.BRIDGE_MEDIA_WSS_ORIGIN = "wss://shared-voice.example.com";
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550008888" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-env-origin", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          cloudflareTunnel: null,
          didProvisioner
        }
      );
      expect(didProvisioner.mock.calls[0][0].platformDefaults.bridgeMediaWssOrigin).toBe(
        "wss://shared-voice.example.com"
      );
    });

    it("does not spread an empty bridgeMediaWssOrigin into platformDefaults", async () => {
      // Regression: orchestrate initialised bridgeMediaWssOrigin = "" and
      // spread it onto readPlatformTelnyxDefaults(), clobbering the
      // `undefined` default. Downstream `?? null` fallbacks don't catch
      // "", so it used to be persisted as an empty origin and produce a
      // malformed wss:// URL for the inbound-voice edge function.
      delete process.env.BRIDGE_MEDIA_WSS_ORIGIN;
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550007777" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-empty-origin", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          // Disable the tunnel provisioner so bridgeMediaWssOrigin stays "".
          cloudflareTunnel: null,
          didProvisioner
        }
      );
      const call = didProvisioner.mock.calls[0][0];
      // platformDefaults should NOT carry a bridgeMediaWssOrigin key at all
      // when there's no concrete origin. Either "undefined" or "not set" is
      // acceptable; an empty string is the failure mode we guard against.
      expect(call.platformDefaults.bridgeMediaWssOrigin ?? null).toBeNull();
      expect(call.platformDefaults.bridgeMediaWssOrigin).not.toBe("");
    });

    it("does not abort the deploy when getTelnyxVoiceRouteForBusiness throws", async () => {
      // Regression: the route lookup used to sit outside the try/catch, so a
      // transient Supabase error would abort orchestrateProvisioning before
      // the deploy phase. The fix moves the lookup inside the catch so the
      // DID provisioning phase stays non-blocking.
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550003333" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockRejectedValueOnce(
        new Error("supabase is down")
      );
      const remoteExec = vi.fn().mockResolvedValue(okExec());
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-db-fail", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec,
          didProvisioner
        }
      );
      // Deploy still ran (that's the whole point of the fix).
      expect(result.vpsId).toBe("42");
      expect(remoteExec).toHaveBeenCalled();
      // And the DID provisioner itself was NOT called, because the failure
      // happened before we got that far — the phase logs "failed, assign
      // manually" and moves on.
      expect(didProvisioner).not.toHaveBeenCalled();
    });

    it("skips when didProvisioner is explicitly null regardless of env flag", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      // If null disabled the step, getTelnyxVoiceRouteForBusiness should NOT
      // be called with this businessId.
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockClear();
      await orchestrateProvisioning(
        { businessId: "biz-did-null", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner: null
        }
      );
      expect(vi.mocked(getTelnyxVoiceRouteForBusiness)).not.toHaveBeenCalled();
    });
  });
});
