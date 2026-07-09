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
import { recordProvisioningProgress } from "@/lib/provisioning/progress";
import * as fs from "fs";
import type { ProvisionVpsForBusinessResult } from "@/lib/hostinger/provision";
import type { SshExecResult } from "@/lib/hostinger/ssh";

vi.mock("@/lib/db/businesses", () => ({
  updateBusinessStatus: vi.fn().mockResolvedValue(undefined),
  updateBusinessVpsSize: vi.fn().mockResolvedValue(undefined),
  getBusiness: vi.fn().mockResolvedValue({ business_type: "real_estate" })
}));

// Per-tenant gateway token now resolves from the DB during provisioning: read
// the active token, or mint + persist one BEFORE the deploy (it doubles as the
// in-deploy progress-callback bearer). The reader echoes the shared env token so
// the deploy-command assertion (ROWBOAT_GATEWAY_TOKEN=mock_gateway_token) stays
// deterministic; when the env is unset the reader returns null so the mint path
// runs with a fixed persisted value.
vi.mock("@/lib/residency/backup-keys", () => ({
  // Escrow resolve hits the DB only on the residency path; deterministic
  // here ("" would mean customer_held custody — see the dedicated test).
  resolveResidencyBackupPassphraseForDeploy: vi.fn(async () => "escrowed-backup-pass")
}));

vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  getActiveGatewayTokenForBusiness: vi.fn(async () => process.env.ROWBOAT_GATEWAY_TOKEN ?? null),
  issueGatewayToken: vi.fn(async () => "minted-per-tenant-tok"),
  markGatewayTokenDeployed: vi.fn(async () => undefined),
  // Residency-only bearer list (DATA_API_TOKENS). Empty by default: only the
  // residency tests exercise it, overriding per-test.
  listActiveGatewayTokensForBusiness: vi.fn(async () => [])
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

vi.mock("@/lib/email/tenant-mailbox", () => ({
  ensureTenantMailbox: vi.fn().mockResolvedValue({
    business_id: "b",
    local_part: "biz",
    personalized: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z"
  })
}));

// The orchestrator's default VpsPool is wired to these accessors (fleet
// economics Phase B). Tests that don't inject `vpsPool` fall through to the
// default, which must never reach a real database: claim finds nothing (→
// purchase path, the pre-pool behavior) and the bookkeeping writes no-op.
vi.mock("@/lib/db/vps-inventory", () => ({
  claimAvailableVps: vi.fn().mockResolvedValue(null),
  recordVpsAssigned: vi.fn().mockResolvedValue(undefined),
  releaseVpsToPool: vi.fn().mockResolvedValue(undefined),
  retireVps: vi.fn().mockResolvedValue(undefined),
  // Consumed only by the default orphanReconciler closure (never invoked in
  // tests — every reconciliation test injects its own reconciler).
  listVpsInventory: vi.fn().mockResolvedValue([])
}));

// Adopt-time stale-tenant cascade (admin release-to-pool flow). Mocked
// wholesale so orchestrator tests never load @/lib/auth transitively; its
// own behavior is covered in stale-tenant-cleanup.test.ts.
vi.mock("@/lib/provisioning/stale-tenant-cleanup", () => ({
  cleanupStaleTenantsForVm: vi.fn().mockResolvedValue({ deletedBusinessIds: [] })
}));

vi.mock("@/lib/db/telnyx-routes", () => ({
  getTelnyxVoiceRouteForBusiness: vi.fn().mockResolvedValue(null),
  // tendlc-attach.ts persists per-business 10DLC status via this helper —
  // the orchestrator dynamically imports tendlc-attach.ts after a successful
  // DID assign, so we have to provide a stub or every did-assign test path
  // throws "is not a function" inside the success branch.
  setBusinessMessagingCampaignStatus: vi.fn().mockResolvedValue(undefined)
}));

import { updateBusinessStatus, updateBusinessVpsSize, getBusiness } from "@/lib/db/businesses";
import {
  getActiveGatewayTokenForBusiness,
  issueGatewayToken,
  listActiveGatewayTokensForBusiness,
  markGatewayTokenDeployed
} from "@/lib/db/vps-gateway-tokens";
import { upsertBusinessConfig, getBusinessConfig } from "@/lib/db/configs";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";
import { ensureTenantMailbox } from "@/lib/email/tenant-mailbox";
import { cleanupStaleTenantsForVm } from "@/lib/provisioning/stale-tenant-cleanup";

function makeVpsStub(
  vpsId = "42",
  publicIp = "1.2.3.4",
  privateKeyPem = "PEM",
  /**
   * `null` = SSH-bootstrap fallback path (PIS attach 403'd OR not eligible).
   * `number` = Hostinger PIS attached + presumed running at first boot. The
   * orchestrator runs SSH-bootstrap as a verify pass either way, so most
   * tests don't care; opt-in by passing a number when asserting on the
   * `vps_bootstrapping` / `vps_bootstrapped` progress copy.
   */
  postInstallScriptId: number | null = null
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
      provider: "hostinger",
      region: "us",
      host: null,
      created_at: "2026-01-01T00:00:00Z",
      rotated_at: null
    },
    publicKeyId: 9,
    postInstallScriptId,
    hostingerBillingSubscriptionId: null
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

/**
 * The orchestrator now makes TWO SSH calls per successful provision:
 *   call 0 — bootstrap (`buildDefaultPostInstallScript()` over SSH)
 *   call 1 — deploy (`/opt/deploy-client.sh` over SSH)
 *
 * Tests that inspect "the deploy command" used to index `mock.calls[0][0]`.
 * Use this helper so the intent (deploy-call inspection) survives a future
 * reorder, and so a stale call-0 hit can't silently start asserting against
 * the bootstrap command.
 */
function deployCallArg(remoteExec: ReturnType<typeof vi.fn>): {
  host: string;
  username: string;
  privateKeyPem: string;
  command: string;
} {
  const found = remoteExec.mock.calls.find((args: unknown[]) => {
    const first = args[0] as { command?: unknown } | undefined;
    return typeof first?.command === "string" && first.command.includes("/opt/deploy-client.sh");
  });
  if (!found) {
    throw new Error(
      "deployCallArg: no /opt/deploy-client.sh invocation recorded on remoteExec"
    );
  }
  return found[0];
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
      TELNYX_MESSAGING_PROFILE_ID: "mock_prof",
      // Required by assertPlatformTelnyxDefaults() before the
      // orchestrator places a number order. The May 2026 outage
      // (number ordered with `connection_id: ""`, calls failed with
      // "the call could not be completed") was the symptom of THIS
      // value being unset in production. Tests for the assertion
      // path delete it explicitly below.
      TELNYX_CONNECTION_ID: "mock_conn"
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
    // VOICE_TRANSCRIPTION_ENABLED is read by the deploy-command builder
    // (orchestrate.ts ~498) and falls back to "" when unset. Without
    // this scrub, a developer who has the var exported in their local
    // shell sees the LHS-of-`??` branch covered every test but the RHS
    // (empty fallback) never. CI catches it as a branch-coverage gap.
    // The "deploy command forwards voice-bridge env when set" test
    // re-sets the var explicitly, which keeps the populated branch
    // covered.
    delete process.env.VOICE_TRANSCRIPTION_ENABLED;
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
    expect(result.tunnelUrl).toContain(".newcoworker.com");
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-uuid-1",
      tier: "starter",
      vpsSize: "kvm1",
      billingPeriod: null
    });
  });

  it("reuses an existing per-tenant token without re-persisting it", async () => {
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValueOnce("existing-per-tenant-tok");
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "standard", ownerEmail: "o@test.com" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "ROWBOAT_GATEWAY_TOKEN", "existing-per-tenant-tok");
    // Existing token: nothing new is minted or persisted.
    expect(issueGatewayToken).not.toHaveBeenCalled();
  });

  it("mints a PENDING token before deploy, injects it, and confirms it after", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValueOnce(null);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "standard", ownerEmail: "o@test.com" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "ROWBOAT_GATEWAY_TOKEN", "minted-per-tenant-tok");
    expect(issueGatewayToken).toHaveBeenCalledWith(
      "biz-uuid-1",
      expect.objectContaining({ label: "provisioning" })
    );
    // Confirmed only after a successful deploy.
    expect(markGatewayTokenDeployed).toHaveBeenCalledWith("biz-uuid-1", "minted-per-tenant-tok");
  });

  it("does NOT abort when the post-deploy confirm fails (deploy already succeeded)", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValueOnce(null);
    vi.mocked(markGatewayTokenDeployed).mockRejectedValueOnce(new Error("rpc boom"));
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    // The deploy succeeded; a confirm failure must be swallowed (logged) rather
    // than throwing and stranding the tenant before status update.
    await expect(
      orchestrateProvisioning(
        { businessId: "biz-uuid-1", tier: "standard", ownerEmail: "o@test.com" },
        { vpsProvisioner, remoteExec }
      )
    ).resolves.not.toThrow();
    expect(markGatewayTokenDeployed).toHaveBeenCalled();
  });

  it("swallows a non-Error confirm rejection too (String(err) branch)", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValueOnce(null);
    vi.mocked(markGatewayTokenDeployed).mockRejectedValueOnce("plain-string-failure");
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await expect(
      orchestrateProvisioning(
        { businessId: "biz-uuid-1", tier: "standard", ownerEmail: "o@test.com" },
        { vpsProvisioner, remoteExec }
      )
    ).resolves.not.toThrow();
  });

  it("does NOT confirm the token when the deploy fails", async () => {
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    vi.mocked(getActiveGatewayTokenForBusiness).mockResolvedValueOnce(null);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn(async (args: { command?: string }): Promise<SshExecResult> =>
      String(args?.command ?? "").includes("/opt/deploy-client.sh")
        ? { exitCode: 1, signal: null, stdout: "", stderr: "boom" }
        : okExec()
    );
    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "standard", ownerEmail: "o@test.com" },
      { vpsProvisioner, remoteExec }
    );
    // Token was minted (pending) but never confirmed, so a retry reuses it.
    expect(issueGatewayToken).toHaveBeenCalled();
    expect(markGatewayTokenDeployed).not.toHaveBeenCalled();
  });

  it("aborts provisioning when the per-tenant token lookup fails", async () => {
    vi.mocked(getActiveGatewayTokenForBusiness).mockRejectedValueOnce(new Error("db down"));
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await expect(
      orchestrateProvisioning(
        { businessId: "biz-uuid-1", tier: "standard", ownerEmail: "o@test.com" },
        { vpsProvisioner, remoteExec }
      )
    ).rejects.toThrow(/db down/);
    // Bootstrap may have run, but the deploy step must not have.
    const ranDeploy = remoteExec.mock.calls.some((c) =>
      String((c[0] as { command?: string } | undefined)?.command ?? "").includes("/opt/deploy-client.sh")
    );
    expect(ranDeploy).toBe(false);
    expect(issueGatewayToken).not.toHaveBeenCalled();
  });

  it("starter tier forwards to provisioner with tier='starter' and default kvm1 hardware", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s1"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-kvm1", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-kvm1",
      tier: "starter",
      vpsSize: "kvm1",
      billingPeriod: null
    });
  });

  it("standard tier forwards to provisioner with tier='standard' and default kvm2 hardware", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s2"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-std-default", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-std-default",
      tier: "standard",
      vpsSize: "kvm2",
      billingPeriod: null
    });
  });

  it("an explicit vps_size pin overrides the tier default (standard on kvm8) and lands in bootstrap + deploy env", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s3"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-std-kvm8", tier: "standard", vpsSize: "kvm8" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-std-kvm8",
      tier: "standard",
      vpsSize: "kvm8",
      billingPeriod: null
    });
    // Bootstrap (call 0) carries the pinned hardware profile: the slim
    // loader is base64-embedded, so decode it before asserting.
    const bootstrapCall = remoteExec.mock.calls[0][0] as { command: string };
    const b64 = /printf '%s' '([^']+)'/.exec(bootstrapCall.command)?.[1] ?? "";
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain("TIER='standard' VPS_SIZE='kvm8' bash");
    // Deploy env carries the hardware profile for deploy-client.sh.
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "VPS_SIZE", "kvm8");
    expectDeployHasEnv(cmd, "TIER", "standard");
  });

  it("a corrupt vps_size value falls back to the tier default instead of failing", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s4"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-corrupt", tier: "starter", vpsSize: "kvm999" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-corrupt",
      tier: "starter",
      vpsSize: "kvm1",
      billingPeriod: null
    });
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

  it("persists the resolved vps_size pin only after hostinger_vps_id points at the new box", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-uuid-1", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    expect(updateBusinessVpsSize).toHaveBeenCalledWith("biz-uuid-1", "kvm1");
    // Pin write must come AFTER updateBusinessStatus("offline", newVpsId) —
    // never while hostinger_vps_id still references the previous box.
    const statusOrder = vi.mocked(updateBusinessStatus).mock.invocationCallOrder[0];
    const pinOrder = vi.mocked(updateBusinessVpsSize).mock.invocationCallOrder[0];
    expect(pinOrder).toBeGreaterThan(statusOrder);

    vi.mocked(updateBusinessVpsSize).mockClear();
    await orchestrateProvisioning(
      { businessId: "biz-uuid-2", tier: "standard", vpsSize: "kvm2" },
      { vpsProvisioner, remoteExec }
    );
    expect(updateBusinessVpsSize).toHaveBeenCalledWith("biz-uuid-2", "kvm2");
  });

  it("fails the provision when the vps_size pin write fails (no silent unpinned kvm1)", async () => {
    // An unpinned kvm1 box would be treated as legacy kvm2/kvm8 hardware:
    // over-cap SMS would route to a local model that doesn't exist and fleet
    // redeploys would push an Ollama profile onto it. Surfacing the error (and
    // letting the provision retry) beats completing with a wrong-hardware pin.
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    vi.mocked(updateBusinessVpsSize).mockRejectedValueOnce(new Error("db blip"));
    await expect(
      orchestrateProvisioning(
        { businessId: "biz-uuid-1", tier: "starter" },
        { vpsProvisioner, remoteExec }
      )
    ).rejects.toThrow("db blip");
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

  it("bakes an enterprise custom compliance module into the provisioned soul", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise",
      compliance_module: {
        customPrompt: "Never quote settlement amounts on any channel.",
        forbiddenTerms: ["merger"]
      }
    } as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());

    await orchestrateProvisioning(
      { businessId: "biz-comp-mod", tier: "enterprise" },
      { vpsProvisioner, remoteExec }
    );

    const call = vi.mocked(upsertBusinessConfig).mock.calls[0][0] as { soul_md: string };
    expect(call.soul_md).toContain("CUSTOM_COMPLIANCE_MODULE_START");
    expect(call.soul_md).toContain("Never quote settlement amounts on any channel.");
    expect(call.soul_md).toContain("- merger");
    // Platform guardrail still present — the module is additive.
    expect(call.soul_md).toContain("## Compliance");
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
    const cmd = deployCallArg(remoteExec).command;
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
    delete process.env.GEMINI_ROWBOAT_MODEL;
    delete process.env.OWNER_CHAT_MODEL;
    delete process.env.APP_BASE_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VOICE_BRIDGE_SRC;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NOTIFICATIONS_WEBHOOK_TOKEN;
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-empty-env", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
    expect(cmd).toContain("TELNYX_API_KEY=''");
    expect(cmd).toContain("TELNYX_MESSAGING_PROFILE_ID=''");
    expect(cmd).toContain("TELNYX_SMS_FROM_E164=''");
    expect(cmd).toContain("STREAM_URL_SIGNING_SECRET=''");
    expect(cmd).toContain("BRIDGE_MEDIA_WSS_ORIGIN=''");
    expect(cmd).toContain("GOOGLE_API_KEY=''");
    expect(cmd).toContain("GEMINI_LIVE_MODEL=''");
    expect(cmd).toContain("GEMINI_LIVE_ENABLED=''");
    expect(cmd).toContain("GEMINI_ROWBOAT_MODEL=''");
    expect(cmd).toContain("OWNER_CHAT_MODEL=''");
    expect(cmd).toContain("APP_BASE_URL=''");
    expect(cmd).toContain("VOICE_BRIDGE_SRC=''");
    expect(cmd).toContain("SUPABASE_SERVICE_KEY=''");
    expect(cmd).toContain("NOTIFICATIONS_WEBHOOK_TOKEN=''");
  });

  it("skips SMS notification when neither ownerPhone nor TELNYX_OWNER_PHONE is set", async () => {
    delete process.env.TELNYX_OWNER_PHONE;
    const { sendTelnyxSms } = await import("@/lib/telnyx/messaging");
    vi.mocked(sendTelnyxSms).mockClear();
    const result = await orchestrateProvisioning(
      { businessId: "biz-no-phone", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.vpsId).toBe("42");
    expect(sendTelnyxSms).not.toHaveBeenCalled();
  });

  it("skips email notification when neither ownerEmail nor ADMIN_EMAIL is set", async () => {
    delete process.env.ADMIN_EMAIL;
    const { sendOwnerEmail } = await import("@/lib/email/client");
    vi.mocked(sendOwnerEmail).mockClear();
    const result = await orchestrateProvisioning(
      { businessId: "biz-no-email", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.vpsId).toBe("42");
    expect(sendOwnerEmail).not.toHaveBeenCalled();
  });

  it("does not abort the deploy when AI-mailbox reservation fails (Error and non-Error)", async () => {
    vi.mocked(ensureTenantMailbox).mockRejectedValueOnce(new Error("mailbox db down"));
    const result = await orchestrateProvisioning(
      { businessId: "biz-mailbox-fail", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result.vpsId).toBe("42");
    expect(ensureTenantMailbox).toHaveBeenCalledWith("biz-mailbox-fail");

    // Non-Error rejection exercises the String(err) fallback branch.
    vi.mocked(ensureTenantMailbox).mockRejectedValueOnce("mailbox weird");
    const result2 = await orchestrateProvisioning(
      { businessId: "biz-mailbox-fail-2", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec())
      }
    );
    expect(result2.vpsId).toBe("42");
  });

  it("deploy command forwards voice-bridge env when set", async () => {
    process.env.GOOGLE_API_KEY = "sk-live-abc";
    process.env.GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
    process.env.GEMINI_LIVE_ENABLED = "false";
    // VOICE_TRANSCRIPTION_ENABLED is set here so the populated branch of
    // its `?? ""` nullish-coalescing is exercised; the other deploy-env
    // tests in this file leave the var unset, which already covers the
    // empty-fallback branch.
    process.env.VOICE_TRANSCRIPTION_ENABLED = "true";
    process.env.VOICE_BRIDGE_SRC = "/opt/newcoworker-repo/vps/voice-bridge";
    process.env.VOICE_NAME = "Puck";
    process.env.SMS_CHAT_MODEL = "gemini-2.5-flash-lite";
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-bridge", tier: "standard" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "GOOGLE_API_KEY", "sk-live-abc");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_ENABLED", "false");
    expectDeployHasEnv(cmd, "VOICE_TRANSCRIPTION_ENABLED", "true");
    expectDeployHasEnv(cmd, "VOICE_BRIDGE_SRC", "/opt/newcoworker-repo/vps/voice-bridge");
    expectDeployHasEnv(cmd, "VOICE_NAME", "Puck");
    expectDeployHasEnv(cmd, "SMS_CHAT_MODEL", "gemini-2.5-flash-lite");
  });

  it("per-tenant enterprise model overrides win over platform env", async () => {
    process.env.GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
    process.env.OWNER_CHAT_MODEL = "gemini-2.5-flash-lite";
    process.env.SMS_CHAT_MODEL = "gemini-2.5-flash-lite";
    process.env.VOICE_NAME = "Puck";
    // Once-scoped so the module-level default row keeps serving later tests.
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise",
      enterprise_models: {
        ownerChatModel: "gemini-3.1-pro",
        smsChatModel: "gemini-3.1-flash",
        geminiLiveModel: "gemini-3.2-flash-live-preview",
        voiceName: "Aoede"
      }
    } as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-ent-models", tier: "enterprise" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "OWNER_CHAT_MODEL", "gemini-3.1-pro");
    expectDeployHasEnv(cmd, "SMS_CHAT_MODEL", "gemini-3.1-flash");
    expectDeployHasEnv(cmd, "GEMINI_LIVE_MODEL", "gemini-3.2-flash-live-preview");
    expectDeployHasEnv(cmd, "VOICE_NAME", "Aoede");
  });

  it("deploy command includes Telnyx env and gateway token", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-env", tier: "starter" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
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
    const arg = deployCallArg(remoteExec);
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

  // Deploy-failure tests: bootstrap (call 0) must succeed so the orchestrator
  // reaches the deploy phase, then deploy (call 1) exhibits the failure being
  // asserted. Bootstrap failure is FATAL and is covered separately below.
  it("continues when deploy remoteExec returns non-zero exit code", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(okExec())
      .mockResolvedValueOnce({ exitCode: 1, signal: null, stdout: "", stderr: "deploy failed" });
    const result = await orchestrateProvisioning(
      { businessId: "biz-fail-exec", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues when deploy remoteExec non-zero with empty stderr/stdout", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(okExec())
      .mockResolvedValueOnce({ exitCode: 1, signal: null, stdout: "", stderr: "" });
    const result = await orchestrateProvisioning(
      { businessId: "biz-fail-exec-empty", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues when deploy remoteExec throws an Error", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(okExec())
      .mockRejectedValueOnce(new Error("SSH timeout"));
    const result = await orchestrateProvisioning(
      { businessId: "biz-err-exec", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec
      }
    );
    expect(result.vpsId).toBe("42");
  });

  it("continues when deploy remoteExec throws a non-Error value", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(okExec())
      .mockRejectedValueOnce("network error");
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
      deployCallArg(remoteExec).command,
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
      deployCallArg(remoteExec).command,
      "NOTIFICATIONS_WEBHOOK_TOKEN",
      "service-key-fallback"
    );
  });

  it("enterprise tier provisions on the standard box profile with default kvm8 hardware", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e1"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-enterprise", tier: "enterprise" },
      { vpsProvisioner, remoteExec }
    );
    // The box tier narrows to STANDARD (compose stack, Ollama model
    // selection) while the hardware default is the enterprise kvm8.
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-enterprise",
      tier: "standard",
      vpsSize: "kvm8",
      billingPeriod: null
    });
    const bootstrapCall = remoteExec.mock.calls[0][0] as { command: string };
    const b64 = /printf '%s' '([^']+)'/.exec(bootstrapCall.command)?.[1] ?? "";
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain("TIER='standard' VPS_SIZE='kvm8' bash");
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "TIER", "standard");
    expectDeployHasEnv(cmd, "VPS_SIZE", "kvm8");
  });

  it("enterprise honors an explicit vps_size pin over the kvm8 default", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e2"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-enterprise-2", tier: "enterprise", vpsSize: "kvm2" },
      { vpsProvisioner, remoteExec }
    );
    expect(vpsProvisioner).toHaveBeenCalledWith({
      businessId: "biz-enterprise-2",
      tier: "standard",
      vpsSize: "kvm2",
      billingPeriod: null
    });
  });

  it("enterprise publishes the render tunnel hostname (standard-plus entitlement)", async () => {
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e3"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "t-ent",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-ent.newcoworker.com",
      voiceHostname: "voice-biz-ent.newcoworker.com",
      renderHostname: "render-biz-ent.newcoworker.com"
    });
    await orchestrateProvisioning(
      { businessId: "biz-ent", tier: "enterprise" },
      { vpsProvisioner, remoteExec, cloudflareTunnel: cfStub }
    );
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-ent",
      renderEnabled: true,
      dataEnabled: false
    });
  });

  it("enterprise with residency past 'supabase' publishes the data hostname + deploy flag", async () => {
    // The gate keys on the REAL tier from the business row (the box tier is
    // narrowed to standard) plus the enterprise-only data_residency_mode.
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise",
      data_residency_mode: "dual"
    } as never);
    vi.mocked(listActiveGatewayTokensForBusiness).mockResolvedValueOnce([
      "mock_gateway_token",
      "old-rotated-token"
    ]);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e4"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "t-res",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-res.newcoworker.com",
      voiceHostname: "voice-biz-res.newcoworker.com",
      renderHostname: "render-biz-res.newcoworker.com",
      dataHostname: "data-biz-res.newcoworker.com"
    });
    await orchestrateProvisioning(
      { businessId: "biz-res", tier: "enterprise" },
      { vpsProvisioner, remoteExec, cloudflareTunnel: cfStub }
    );
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-res",
      renderEnabled: true,
      dataEnabled: true
    });
    // deploy-client.sh gets the stack gate so the box stands the containers up.
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "DATA_RESIDENCY_ENABLED", "true");
    // Bearer list = every non-revoked token, with the deploy token guaranteed
    // present. The mocked list already contains it, so no prepend happens.
    expectDeployHasEnv(cmd, "DATA_API_TOKENS", "mock_gateway_token,old-rotated-token");
    // Escrowed backup passphrase reaches the box for the encrypted-dump timer.
    expectDeployHasEnv(cmd, "RESIDENCY_BACKUP_PASSPHRASE", "escrowed-backup-pass");
    // Default destination: ciphertext uploads to central Storage.
    expectDeployHasEnv(cmd, "RESIDENCY_BACKUP_DESTINATION", "central");
  });

  it("residency_backup_destination='onbox' reaches the box (in-region ciphertext)", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise",
      data_residency_mode: "vps",
      residency_backup_destination: "onbox"
    } as never);
    vi.mocked(listActiveGatewayTokensForBusiness).mockResolvedValueOnce(["mock_gateway_token"]);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e9"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-res-onbox", tier: "enterprise", ownerEmail: "o@test.com" },
      { vpsProvisioner, remoteExec }
    );
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "RESIDENCY_BACKUP_DESTINATION", "onbox");
  });

  it("prepends the deploy token to DATA_API_TOKENS when the DB list lacks it", async () => {
    // Covers the rotation race where this deploy just minted a token the
    // list read predates — the data-api must still accept it.
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise",
      data_residency_mode: "vps"
    } as never);
    vi.mocked(listActiveGatewayTokensForBusiness).mockResolvedValueOnce(["stale-token"]);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e7"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    await orchestrateProvisioning(
      { businessId: "biz-res-rot", tier: "enterprise" },
      { vpsProvisioner, remoteExec }
    );
    expectDeployHasEnv(
      deployCallArg(remoteExec).command,
      "DATA_API_TOKENS",
      "mock_gateway_token,stale-token"
    );
  });

  it("enterprise still in 'supabase' mode gets no data hostname and an empty deploy flag", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise",
      data_residency_mode: "supabase"
    } as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e5"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "t-res2",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-res2.newcoworker.com",
      voiceHostname: "voice-biz-res2.newcoworker.com",
      renderHostname: "render-biz-res2.newcoworker.com"
    });
    await orchestrateProvisioning(
      { businessId: "biz-res2", tier: "enterprise" },
      { vpsProvisioner, remoteExec, cloudflareTunnel: cfStub }
    );
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-res2",
      renderEnabled: true,
      dataEnabled: false
    });
    const offCmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(offCmd, "DATA_RESIDENCY_ENABLED", "");
    // No escrow mint for non-residency deploys — the passphrase stays empty.
    expectDeployHasEnv(offCmd, "RESIDENCY_BACKUP_PASSPHRASE", "");
  });

  it("enterprise with NO residency column (pre-migration row) defaults to supabase mode", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "enterprise"
    } as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("e6"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "t-res3",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-res3.newcoworker.com",
      voiceHostname: "voice-biz-res3.newcoworker.com",
      renderHostname: "render-biz-res3.newcoworker.com"
    });
    await orchestrateProvisioning(
      { businessId: "biz-res3", tier: "enterprise" },
      { vpsProvisioner, remoteExec, cloudflareTunnel: cfStub }
    );
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-res3",
      renderEnabled: true,
      dataEnabled: false
    });
  });

  it("a non-enterprise tenant never gets the data plane even with a stray residency mode", async () => {
    // Defense-in-depth: the DB gate blocks non-enterprise forward flips, but
    // the orchestrator re-checks the tier so a corrupt row can't leak a
    // data hostname onto a standard box.
    vi.mocked(getBusiness).mockResolvedValueOnce({
      business_type: "real_estate",
      tier: "standard",
      data_residency_mode: "vps"
    } as never);
    const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("s9"));
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "t-std9",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-std9.newcoworker.com",
      voiceHostname: "voice-biz-std9.newcoworker.com",
      renderHostname: "render-biz-std9.newcoworker.com"
    });
    await orchestrateProvisioning(
      { businessId: "biz-std9", tier: "standard" },
      { vpsProvisioner, remoteExec, cloudflareTunnel: cfStub }
    );
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-std9",
      renderEnabled: true,
      dataEnabled: false
    });
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
    expect(deployCallArg(remoteExec).command).toContain("SUPABASE_URL=''");
  });

  it("per-tenant tunnel: uses CF provisioner token + hostname when injected", async () => {
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "tun-42",
      token: "PER_TENANT_TOKEN",
      hostname: "biz-cf.newcoworker.com",
      voiceHostname: "voice-biz-cf.newcoworker.com"
    });
    const result = await orchestrateProvisioning(
      { businessId: "biz-cf", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: cfStub
      }
    );
    // Starter tier: render sidecar is NOT deployed, so the tunnel must not
    // publish a render hostname for it.
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-cf",
      renderEnabled: false,
      dataEnabled: false
    });
    expect(result.tunnelUrl).toBe("https://biz-cf.newcoworker.com");
    const cmd = deployCallArg(remoteExec).command;
    expectDeployHasEnv(cmd, "CLOUDFLARE_TUNNEL_TOKEN", "PER_TENANT_TOKEN");
    expectDeployHasEnv(cmd, "BRIDGE_MEDIA_WSS_ORIGIN", "wss://voice-biz-cf.newcoworker.com");
  });

  it("per-tenant tunnel: enables the render hostname on non-starter (standard) tiers", async () => {
    process.env.AIFLOW_RENDER_TOKEN = "RENDER_BEARER";
    const remoteExec = vi.fn().mockResolvedValue(okExec());
    const cfStub = vi.fn().mockResolvedValue({
      tunnelId: "tun-43",
      token: "PER_TENANT_TOKEN_STD",
      hostname: "biz-std.newcoworker.com",
      voiceHostname: "voice-biz-std.newcoworker.com",
      renderHostname: "render-biz-std.newcoworker.com"
    });
    await orchestrateProvisioning(
      { businessId: "biz-std", tier: "standard" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec,
        cloudflareTunnel: cfStub
      }
    );
    expect(cfStub).toHaveBeenCalledWith({
      businessId: "biz-std",
      renderEnabled: true,
      dataEnabled: false
    });
    // The shared render bearer must reach the VPS deploy command.
    expectDeployHasEnv(deployCallArg(remoteExec).command, "AIFLOW_RENDER_TOKEN", "RENDER_BEARER");
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
    expect(result.tunnelUrl).toBe("https://biz-cf-fail.newcoworker.com");
    const cmd = deployCallArg(remoteExec).command;
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
    expect(result.tunnelUrl).toBe("https://biz-cf-nonerr.newcoworker.com");
    expectDeployHasEnv(
      deployCallArg(remoteExec).command,
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
    expect(result.tunnelUrl).toBe("https://biz-cf-null.newcoworker.com");
    expectDeployHasEnv(
      deployCallArg(remoteExec).command,
      "CLOUDFLARE_TUNNEL_TOKEN",
      "LEGACY_TOKEN"
    );
  });

  // Regression: dotenv parses `CLOUDFLARE_TUNNEL_ZONE=` (the form documented
  // in `.env.example` for "leave at default") as the empty string, which `??`
  // treats as defined and would yield the malformed `"<biz>."` hostname when
  // the tunnel provisioner is disabled. Coercing blank to undefined before
  // the fallback keeps the hostname well-formed.
  it.each(["", "   ", "\t\n"])(
    "per-tenant tunnel: blank CLOUDFLARE_TUNNEL_ZONE (%j) falls back to newcoworker.com without producing a malformed hostname",
    async (blankValue) => {
      process.env.CLOUDFLARE_TUNNEL_ZONE = blankValue;
      const result = await orchestrateProvisioning(
        { businessId: "biz-blank-zone", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          cloudflareTunnel: null
        }
      );
      expect(result.tunnelUrl).toBe("https://biz-blank-zone.newcoworker.com");
      expect(result.tunnelUrl).not.toMatch(/\.\s*$/);
      expect(result.tunnelUrl).not.toBe("https://biz-blank-zone.");
    }
  );

  it("per-tenant tunnel: explicit non-blank CLOUDFLARE_TUNNEL_ZONE is honored (and trimmed) by the null-provisioner fallback", async () => {
    process.env.CLOUDFLARE_TUNNEL_ZONE = "  custom.example.com  ";
    const result = await orchestrateProvisioning(
      { businessId: "biz-custom-zone", tier: "starter" },
      {
        vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
        remoteExec: vi.fn().mockResolvedValue(okExec()),
        cloudflareTunnel: null
      }
    );
    expect(result.tunnelUrl).toBe("https://biz-custom-zone.custom.example.com");
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
      deployCallArg(remoteExec).command,
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

    it("derives search.areaCode from the owner's onboarding phone (local number)", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      // Env defaults are present but should be OVERRIDDEN by the local code.
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      // getBusiness is loaded once during the run; the DID phase reuses that
      // businessRow to derive the local area code.
      const biz = { business_type: "real_estate", phone: "(602) 555-0100" } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+16025550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-local", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          // Local area code wins, and the contradictory env state filter is
          // dropped so the two filters can't zero out the search.
          search: expect.objectContaining({ areaCode: "602", administrativeArea: undefined })
        })
      );
    });

    it("buys a Canadian number on the CA messaging profile for a Canadian tenant", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_MESSAGING_PROFILE_ID_CA = "mock_prof_ca";
      const biz = { business_type: "insurance", phone: "(416) 456-0696" } as never; // Toronto
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+14165550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-ca", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          // Number purchased in Canada, biased to the owner's area code, and
          // wired to the CA-whitelisted messaging profile so outbound SMS to
          // Canadian leads doesn't 40309 (the Truly Insurance incident).
          search: expect.objectContaining({ countryCode: "CA", areaCode: "416" }),
          platformDefaults: expect.objectContaining({ messagingProfileId: "mock_prof_ca" })
        })
      );
      delete process.env.TELNYX_MESSAGING_PROFILE_ID_CA;
    });

    it("searches ANY Canadian number for a timezone-classified Canadian tenant (US env defaults never applied)", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      // Non-NANP phone → no derivable area code; Canadian by timezone. The
      // primary search must not be "US area 212 in country CA", which would
      // zero out inventory and (with no localAreaCode) never retry.
      const biz = {
        business_type: "insurance",
        phone: "+447911123456",
        timezone: "America/Toronto"
      } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+16475550101" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-ca-tz", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          search: { countryCode: "CA", areaCode: undefined, administrativeArea: undefined }
        })
      );
    });

    it("still provisions a Canadian tenant when TELNYX_MESSAGING_PROFILE_ID_CA is unset (loud warn, default profile)", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      delete process.env.TELNYX_MESSAGING_PROFILE_ID_CA;
      const biz = { business_type: "insurance", phone: "6474494244" } as never; // Toronto
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+16475550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-ca-noenv", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({ countryCode: "CA" }),
          platformDefaults: expect.objectContaining({ messagingProfileId: "mock_prof" })
        })
      );
    });

    it("broadens a Canadian no-inventory retry to any CA number (never the US env defaults)", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_MESSAGING_PROFILE_ID_CA = "mock_prof_ca";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      const biz = { business_type: "insurance", phone: "(519) 800-6401" } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const didProvisioner = vi
        .fn()
        .mockRejectedValueOnce(new OrderAndAssignError("no_numbers_available", "none local"))
        .mockResolvedValueOnce({ toE164: "+14375550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-ca-retry", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledTimes(2);
      expect(didProvisioner.mock.calls[0][0].search).toMatchObject({
        countryCode: "CA",
        areaCode: "519"
      });
      // Retry must not reuse the US-centric 212/NY defaults against a CA
      // country search — broaden to any Canadian number.
      expect(didProvisioner.mock.calls[1][0].search.countryCode).toBe("CA");
      expect(didProvisioner.mock.calls[1][0].search.areaCode).toBeUndefined();
      expect(didProvisioner.mock.calls[1][0].search.administrativeArea).toBeUndefined();
      delete process.env.TELNYX_MESSAGING_PROFILE_ID_CA;
    });

    it("falls back to TELNYX_DEFAULT_AREA_CODE when the owner phone is not a NANP number", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      const biz = { business_type: "real_estate", phone: "+447911123456" } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+12125550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-intl", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({ areaCode: "212", administrativeArea: "NY" })
        })
      );
    });

    it("retries with the default area code when no number is available in the local area code", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      const biz = { business_type: "real_estate", phone: "(602) 555-0100" } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const didProvisioner = vi
        .fn()
        .mockRejectedValueOnce(new OrderAndAssignError("no_numbers_available", "none local"))
        .mockResolvedValueOnce({ toE164: "+12125550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-retry", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledTimes(2);
      // First attempt used the owner's local area code…
      expect(didProvisioner.mock.calls[0][0].search.areaCode).toBe("602");
      // …the retry fell back to the platform default (+ its state filter).
      expect(didProvisioner.mock.calls[1][0].search.areaCode).toBe("212");
      expect(didProvisioner.mock.calls[1][0].search.administrativeArea).toBe("NY");
      expect(result.vpsId).toBe("42");
      // The number actually came from the fallback area code, so the
      // did_assigned progress must NOT claim it's local.
      const didAssigned = vi
        .mocked(recordProvisioningProgress)
        .mock.calls.map((c) => c[0])
        .find((p) => p.phase === "did_assigned");
      expect(didAssigned?.message).not.toContain("local area code");
    });

    it("retry broadens to any US number when the default area code equals the local one", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      // Platform default is the SAME NPA the owner is in, so reusing it would
      // re-run the identical (failed) search instead of broadening.
      process.env.TELNYX_DEFAULT_AREA_CODE = "602";
      process.env.TELNYX_DEFAULT_STATE = "AZ";
      const biz = { business_type: "real_estate", phone: "(602) 555-0100" } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const didProvisioner = vi
        .fn()
        .mockRejectedValueOnce(new OrderAndAssignError("no_numbers_available", "none local"))
        .mockResolvedValueOnce({ toE164: "+15125550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-broaden", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledTimes(2);
      expect(didProvisioner.mock.calls[0][0].search.areaCode).toBe("602");
      // The retry drops the area-code + state filters so it can pull any US
      // number instead of re-running the identical failed search.
      expect(didProvisioner.mock.calls[1][0].search.areaCode).toBeUndefined();
      expect(didProvisioner.mock.calls[1][0].search.administrativeArea).toBeUndefined();
      expect(result.vpsId).toBe("42");
    });

    it("puts the signup-requested area code first, ahead of the owner-derived one", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      const biz = {
        business_type: "insurance_agency",
        phone: "(416) 456-0696",
        preferred_area_code: "519"
      } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15198006401" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-requested", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledTimes(1);
      // 519 is Ontario: the spec must be CA-scoped or Telnyx returns nothing
      // (the Jul 8 2026 Truly Insurance lesson).
      expect(didProvisioner.mock.calls[0][0].search).toEqual({
        countryCode: "CA",
        areaCode: "519",
        administrativeArea: undefined
      });
      const didAssigned = vi
        .mocked(recordProvisioningProgress)
        .mock.calls.map((c) => c[0])
        .find((p) => p.phase === "did_assigned");
      expect(didAssigned?.message).toContain("requested area code 519");
    });

    it("cascades requested → owner-local → platform default → any on sold-out tiers", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      const biz = {
        business_type: "insurance_agency",
        phone: "(416) 456-0696", // 416 = Toronto → owner tier is CA-scoped
        preferred_area_code: "519"
      } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const soldOut = () => new OrderAndAssignError("no_numbers_available", "sold out");
      const didProvisioner = vi
        .fn()
        .mockRejectedValueOnce(soldOut()) // requested 519
        .mockRejectedValueOnce(soldOut()) // owner 416
        .mockRejectedValueOnce(soldOut()) // platform default 212
        .mockResolvedValueOnce({ toE164: "+15550001111" }); // any US
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-cascade", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledTimes(4);
      expect(didProvisioner.mock.calls[0][0].search).toEqual({
        countryCode: "CA",
        areaCode: "519",
        administrativeArea: undefined
      });
      expect(didProvisioner.mock.calls[1][0].search).toEqual({
        countryCode: "CA",
        areaCode: "416",
        administrativeArea: undefined
      });
      expect(didProvisioner.mock.calls[2][0].search).toEqual({
        countryCode: "US",
        areaCode: "212",
        administrativeArea: "NY"
      });
      expect(didProvisioner.mock.calls[3][0].search).toEqual({
        countryCode: "US",
        areaCode: undefined,
        administrativeArea: undefined
      });
      expect(result.vpsId).toBe("42");
      // The number came from the any-tier — no locality claims.
      const didAssigned = vi
        .mocked(recordProvisioningProgress)
        .mock.calls.map((c) => c[0])
        .find((p) => p.phase === "did_assigned");
      expect(didAssigned?.message).not.toContain("area code");
    });

    it("dedupes the owner tier when the requested area code matches it", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "212";
      process.env.TELNYX_DEFAULT_STATE = "NY";
      const biz = {
        business_type: "real_estate",
        phone: "(602) 555-0100",
        preferred_area_code: "602"
      } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const didProvisioner = vi
        .fn()
        .mockRejectedValueOnce(new OrderAndAssignError("no_numbers_available", "sold out"))
        .mockResolvedValueOnce({ toE164: "+12125550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-dedupe", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      // 602 tried ONCE (as `requested`), then straight to the platform
      // default — no duplicate owner-tier search of the same NPA.
      expect(didProvisioner).toHaveBeenCalledTimes(2);
      expect(didProvisioner.mock.calls[0][0].search.areaCode).toBe("602");
      expect(didProvisioner.mock.calls[1][0].search.areaCode).toBe("212");
    });

    it("ignores an invalid stored preferred_area_code (defense against bad rows)", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "305";
      process.env.TELNYX_DEFAULT_STATE = "FL";
      const biz = {
        business_type: "real_estate",
        phone: "(602) 555-0100",
        preferred_area_code: "1abc"
      } as never;
      vi.mocked(getBusiness).mockResolvedValueOnce(biz);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+16025550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-badpref", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      // Falls straight to the owner-derived tier.
      expect(didProvisioner.mock.calls[0][0].search.areaCode).toBe("602");
      const didAssigned = vi
        .mocked(recordProvisioningProgress)
        .mock.calls.map((c) => c[0])
        .find((p) => p.phase === "did_assigned");
      expect(didAssigned?.message).toContain("local area code 602");
    });

    it("surfaces the error when even the any-country tier has no inventory", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      delete process.env.TELNYX_DEFAULT_AREA_CODE;
      delete process.env.TELNYX_DEFAULT_STATE;
      vi.mocked(getBusiness).mockResolvedValueOnce(null as never);
      const { OrderAndAssignError } = await import("@/lib/telnyx/assign-did");
      const didProvisioner = vi
        .fn()
        .mockRejectedValue(new OrderAndAssignError("no_numbers_available", "nothing at all"));
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-nothing", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      // Plan is just the `any` spec; its failure records the error phase and
      // the deploy continues (DID assignment is non-blocking).
      expect(didProvisioner).toHaveBeenCalledTimes(1);
      expect(result.vpsId).toBe("42");
      const failed = vi
        .mocked(recordProvisioningProgress)
        .mock.calls.map((c) => c[0])
        .find((p) => p.phase === "did_provisioning_failed");
      expect(failed?.message).toContain("no_numbers_available");
    });

    it("falls back to env area code when the business row is missing (no phone to derive from)", async () => {
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      process.env.TELNYX_DEFAULT_AREA_CODE = "305";
      process.env.TELNYX_DEFAULT_STATE = "FL";
      // No business row at all → nothing to derive a local area code from, so
      // the search falls back to the platform default (exercises the
      // `businessRow?.phone` short-circuit).
      vi.mocked(getBusiness).mockResolvedValueOnce(null as never);
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+13055550100" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      const result = await orchestrateProvisioning(
        { businessId: "biz-did-norow", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({ areaCode: "305", administrativeArea: "FL" })
        })
      );
      expect(result.vpsId).toBe("42");
    });

    it("survives a thrown 10DLC attach (catch path: log warn + record `thinking` progress, don't fail orchestrator)", async () => {
      // Force the attach helper's internal DB write to throw — the
      // orchestrator catch block at orchestrate.ts:727-740 must absorb
      // it, log a warning, record the "Will retry" progress message, and
      // proceed to subsequent phases. If the catch path regressed, this
      // test would surface a thrown error escaping orchestrateProvisioning.
      const { setBusinessMessagingCampaignStatus } = await import(
        "@/lib/db/telnyx-routes"
      );
      vi.mocked(setBusinessMessagingCampaignStatus).mockRejectedValueOnce(
        new Error("simulated db write failure")
      );

      const didProvisioner = vi
        .fn()
        .mockResolvedValue({ toE164: "+15550009999" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-did-attach-throws", tier: "starter" },
          {
            vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
            remoteExec: vi.fn().mockResolvedValue(okExec()),
            didProvisioner
          }
        )
      ).resolves.not.toThrow();
      // Reset to the default mock so subsequent tests aren't poisoned.
      // mockResolvedValue is type-checked against the original signature,
      // so cast through `any` — we only need the test mock to not throw.
      vi.mocked(setBusinessMessagingCampaignStatus).mockResolvedValue(
        undefined as never
      );
    });

    it("falls back search.countryCode to 'US' when TELNYX_DEFAULT_COUNTRY is unset", async () => {
      delete process.env.TELNYX_DEFAULT_COUNTRY;
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550004444" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-did-fallback-country", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).toHaveBeenCalledWith(
        expect.objectContaining({
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

    it("refuses to call didProvisioner when TELNYX_CONNECTION_ID is missing — root cause of the May 2026 unwired-DID outage", async () => {
      // The bug: orchestrate.ts spread readPlatformTelnyxDefaults() into
      // platformDefaults; if connectionId was undefined the order went
      // through anyway and Telnyx filed the number with `connection_id: ""`,
      // producing "the call could not be completed" on every inbound call.
      // The assertion guard converts that silent regression into a loud
      // throw (caught by the orchestrator's existing try/catch which
      // logs "DID provisioning failed, assign manually" and continues
      // the deploy without burning a real number order).
      delete process.env.TELNYX_CONNECTION_ID;
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550009999" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      const remoteExec = vi.fn().mockResolvedValue(okExec());
      const result = await orchestrateProvisioning(
        { businessId: "biz-no-conn", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec,
          didProvisioner
        }
      );
      // Critical: the provisioner was NEVER called, so we didn't pay
      // Telnyx for an unwired number.
      expect(didProvisioner).not.toHaveBeenCalled();
      // Deploy still completes — the assertion is a soft-fail at the
      // DID phase, same shape as OrderAndAssignError handling.
      expect(result.vpsId).toBe("42");
      expect(remoteExec).toHaveBeenCalled();
    });

    it("refuses when TELNYX_MESSAGING_PROFILE_ID is missing — SMS would route nowhere even if voice were wired", async () => {
      delete process.env.TELNYX_MESSAGING_PROFILE_ID;
      process.env.TELNYX_AUTO_PURCHASE_DID = "true";
      const didProvisioner = vi.fn().mockResolvedValue({ toE164: "+15550001010" });
      vi.mocked(getTelnyxVoiceRouteForBusiness).mockResolvedValueOnce(null);
      await orchestrateProvisioning(
        { businessId: "biz-no-prof", tier: "starter" },
        {
          vpsProvisioner: vi.fn().mockResolvedValue(makeVpsStub("42")),
          remoteExec: vi.fn().mockResolvedValue(okExec()),
          didProvisioner
        }
      );
      expect(didProvisioner).not.toHaveBeenCalled();
    });
  });

  describe("SSH bootstrap (always-on safety net for Hostinger first-boot PIS)", () => {
    /**
     * Why this exists: Hostinger's `/api/vps/v1/post-install-scripts` is the
     * preferred bootstrap path because it runs concurrently with cloud-init
     * and saves the orchestrator from waiting on sshd. But the endpoint
     * returns `403 [VPS:2000] Unauthorized` until the account already owns
     * at least one VPS — a chicken-and-egg that can't be resolved at the
     * purchase call for brand-new accounts. The orchestrator handles BOTH
     * cases by ALWAYS running an SSH-bootstrap pass after the VPS hits
     * `running`: it re-executes the same idempotent script content, so on
     * a PIS-eligible account it's a fast verify (apt-cache warm, repo
     * already cloned) and on a fresh account it's the only bootstrap.
     * These tests pin that "always-on" contract so a future refactor can't
     * silently regress to the PIS-only path that hangs new accounts.
     */
    it("invokes remoteExec twice: bootstrap (call 0) then deploy (call 1)", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());
      await orchestrateProvisioning(
        { businessId: "biz-bootstrap-order", tier: "starter" },
        { vpsProvisioner, remoteExec }
      );
      expect(remoteExec).toHaveBeenCalledTimes(2);
      const bootstrapCmd = remoteExec.mock.calls[0][0].command as string;
      const deployCmd = remoteExec.mock.calls[1][0].command as string;
      // Bootstrap ships the script as base64 to dodge heredoc/quoting issues.
      expect(bootstrapCmd).toContain("base64 -d");
      expect(bootstrapCmd).toContain("/tmp/newcoworker-bootstrap.sh");
      // Codex P1 fix: bootstrap MUST wait for cloud-init's runcmd to finish
      // before doing anything that touches apt. Without this, a successful
      // PIS attach + concurrent SSH-bootstrap race the dpkg lock and the
      // SSH side fails under `set -euo pipefail`. The wait is also a
      // belt-and-braces no-op when cloud-init isn't installed (handled by
      // the `2>/dev/null || true`).
      expect(bootstrapCmd).toContain("cloud-init status --wait");
      expect(bootstrapCmd).toContain("|| true");
      // Deploy is the existing /opt/deploy-client.sh path with env injection.
      expect(deployCmd).toContain("/opt/deploy-client.sh");
    });

    it("records `vps_bootstrapping` then `vps_bootstrapped` progress rows", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-bootstrap-progress", tier: "starter" },
        { vpsProvisioner, remoteExec }
      );

      const phases = recordMock.mock.calls.map((c) => c[0].phase);
      const bootstrapStartIdx = phases.indexOf("vps_bootstrapping");
      const bootstrapDoneIdx = phases.indexOf("vps_bootstrapped");
      expect(bootstrapStartIdx).toBeGreaterThan(-1);
      expect(bootstrapDoneIdx).toBeGreaterThan(bootstrapStartIdx);
      // Bootstrap must come AFTER vps_provisioned and BEFORE config_upserted.
      const provisionedIdx = phases.indexOf("vps_provisioned");
      const configIdx = phases.indexOf("config_upserted");
      expect(bootstrapStartIdx).toBeGreaterThan(provisionedIdx);
      expect(bootstrapDoneIdx).toBeLessThan(configIdx);
    });

    it("aborts provisioning with a `failed` row when bootstrap exits non-zero", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      // Bootstrap fails with a non-zero exit; the test asserts that the
      // orchestrator does NOT continue to deploy and DOES record a terminal
      // failed row (top-level catch).
      const remoteExec = vi.fn().mockResolvedValueOnce({
        exitCode: 5,
        signal: null,
        stdout: "",
        stderr: "apt-get update failed: lock file in use"
      });

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-bootstrap-fail", tier: "starter" },
          { vpsProvisioner, remoteExec }
        )
      ).rejects.toThrow(/VPS bootstrap failed.*exit 5/);

      // Deploy must not have been attempted.
      expect(remoteExec).toHaveBeenCalledTimes(1);
      const failed = recordMock.mock.calls.map((c) => c[0]).find((p) => p.phase === "failed");
      expect(failed?.status).toBe("error");
      expect(failed?.message).toMatch(/VPS bootstrap failed/);
    });

    it("aborts with empty-output fallback message when bootstrap exits non-zero with no output", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      const remoteExec = vi.fn().mockResolvedValueOnce({
        exitCode: 7,
        signal: null,
        stdout: "",
        stderr: ""
      });
      await expect(
        orchestrateProvisioning(
          { businessId: "biz-bootstrap-silent-fail", tier: "starter" },
          { vpsProvisioner, remoteExec }
        )
      ).rejects.toThrow(/<no output>/);
    });

    it("retries SSH connection on connection-refused / handshake errors and proceeds on eventual success", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      // Bootstrap connection refused twice, then succeeds on the third attempt.
      // Deploy then succeeds. Total remoteExec invocations: 4 (3 bootstrap + 1 deploy).
      const remoteExec = vi.fn();
      remoteExec.mockRejectedValueOnce(new Error("connect ECONNREFUSED 1.2.3.4:22"));
      remoteExec.mockRejectedValueOnce(new Error("Connection refused"));
      remoteExec.mockResolvedValueOnce(okExec()); // bootstrap success
      remoteExec.mockResolvedValueOnce(okExec()); // deploy success

      const sleep = vi.fn().mockResolvedValue(undefined);

      const result = await orchestrateProvisioning(
        { businessId: "biz-bootstrap-retry", tier: "starter" },
        { vpsProvisioner, remoteExec, sleep }
      );

      expect(result.vpsId).toBe("42");
      expect(remoteExec).toHaveBeenCalledTimes(4);
      // Two connect errors → two backoff sleeps. Per `runWithSshConnectRetry`
      // defaults: 5000ms × 1, 5000ms × 2.
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenNthCalledWith(1, 5000);
      expect(sleep).toHaveBeenNthCalledWith(2, 10000);
    });

    it("does NOT retry on non-connect errors during bootstrap (fails fast)", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      const remoteExec = vi.fn().mockRejectedValueOnce(new Error("some unrelated failure"));
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-bootstrap-no-retry", tier: "starter" },
          { vpsProvisioner, remoteExec, sleep }
        )
      ).rejects.toThrow(/some unrelated failure/);

      expect(remoteExec).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("gives up after maxAttempts and surfaces the last connect error", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      // Every bootstrap attempt rejects with a connect error → exhaust retries.
      const remoteExec = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-bootstrap-exhausted", tier: "starter" },
          { vpsProvisioner, remoteExec, sleep }
        )
      ).rejects.toThrow(/ETIMEDOUT/);

      // Default maxAttempts is 6; sleeps happen between attempts (so 5 sleeps).
      expect(remoteExec).toHaveBeenCalledTimes(6);
      expect(sleep).toHaveBeenCalledTimes(5);
    });

    it("classifies handshake / kex errors as connect-retryable", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      const remoteExec = vi.fn();
      remoteExec.mockRejectedValueOnce(new Error("Handshake failed: kex algorithm mismatch"));
      remoteExec.mockResolvedValueOnce(okExec()); // bootstrap success
      remoteExec.mockResolvedValueOnce(okExec()); // deploy success
      const sleep = vi.fn().mockResolvedValue(undefined);

      await orchestrateProvisioning(
        { businessId: "biz-handshake", tier: "starter" },
        { vpsProvisioner, remoteExec, sleep }
      );
      expect(remoteExec).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on non-Error throws (e.g. string rejection)", async () => {
      // Defense-in-depth: if a non-Error value is thrown, isSshConnectError
      // returns false (we can't safely inspect a `.message` property on a
      // string/number/null), so the orchestrator surfaces immediately rather
      // than burning the retry budget on an unrecognizable failure.
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42"));
      const remoteExec = vi.fn().mockRejectedValueOnce("string-thrown");
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-string-throw", tier: "starter" },
          { vpsProvisioner, remoteExec, sleep }
        )
      ).rejects.toBe("string-thrown");
      expect(remoteExec).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    /**
     * PIS-attached path: when `provisionVpsForBusiness` successfully
     * registered a Hostinger post-install-script, the orchestrator's
     * SSH-bootstrap message reads "Verifying" instead of "Bootstrapping".
     * This pins the dashboard copy so an observer can tell whether a
     * provision used the fast PIS path or fell back to SSH-only.
     */
    it("vps_bootstrapping/_bootstrapped messages reflect PIS attached when postInstallScriptId is set", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();
      const vpsProvisioner = vi
        .fn()
        .mockResolvedValue(makeVpsStub("42", "1.2.3.4", "PEM", 7777));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-pis-attached", tier: "starter" },
        { vpsProvisioner, remoteExec }
      );

      const calls = recordMock.mock.calls.map((c) => c[0]);
      const start = calls.find((p) => p.phase === "vps_bootstrapping");
      const done = calls.find((p) => p.phase === "vps_bootstrapped");
      expect(start?.message).toMatch(/Verifying VPS bootstrap.*PIS attached.*7777/);
      expect(done?.message).toMatch(/PIS id=7777.*SSH re-run/);
    });

    /**
     * PIS-skipped path (default for fresh accounts): message reads
     * "Bootstrapping" and explicitly mentions the SSH-only fallback.
     */
    it("vps_bootstrapping/_bootstrapped messages reflect SSH-only fallback when postInstallScriptId is null", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("42")); // null PIS
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-pis-fallback", tier: "starter" },
        { vpsProvisioner, remoteExec }
      );

      const calls = recordMock.mock.calls.map((c) => c[0]);
      const start = calls.find((p) => p.phase === "vps_bootstrapping");
      const done = calls.find((p) => p.phase === "vps_bootstrapped");
      expect(start?.message).toMatch(/Bootstrapping VPS over SSH.*PIS not eligible/);
      expect(done?.message).toMatch(/SSH-only fallback path/);
    });
  });

  describe("adopt-first VPS acquisition (vps_inventory pool)", () => {
    function makePool(overrides: Record<string, unknown> = {}) {
      return {
        claim: vi.fn().mockResolvedValue(null),
        record: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
        retire: vi.fn().mockResolvedValue(undefined),
        ...overrides
      };
    }

    const claimedRow = {
      vm_id: 1800985,
      hostname: "srv1800985.hstgr.cloud",
      plan: "kvm1",
      state: "assigned",
      hostinger_billing_subscription_id: null,
      assigned_business_id: "biz-pool-1",
      acquired_at: "2026-07-01T00:00:00Z",
      assigned_at: "2026-07-04T00:00:00Z",
      notes: null,
      updated_at: "2026-07-04T00:00:00Z"
    };

    it("adopts a pooled box instead of purchasing and records the assignment", async () => {
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const adopted = {
        ...makeVpsStub("1800985"),
        hostingerBillingSubscriptionId: "hsub-adopted"
      };
      const vpsAdopter = vi.fn().mockResolvedValue(adopted);
      const vpsProvisioner = vi.fn();
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-1", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(result.vpsId).toBe("1800985");
      expect(pool.claim).toHaveBeenCalledWith("kvm1", "biz-pool-1");
      expect(vpsAdopter).toHaveBeenCalledWith({
        businessId: "biz-pool-1",
        tier: "starter",
        vpsSize: "kvm1",
        virtualMachineId: 1800985
      });
      expect(vpsProvisioner).not.toHaveBeenCalled();
      expect(pool.record).toHaveBeenCalledWith(
        expect.objectContaining({
          vmId: 1800985,
          plan: "kvm1",
          businessId: "biz-pool-1",
          hostingerBillingSubscriptionId: "hsub-adopted"
        })
      );
      expect(pool.retire).not.toHaveBeenCalled();
    });

    it("purchases when the pool is empty and records the new box as assigned", async () => {
      const pool = makePool();
      const vpsAdopter = vi.fn();
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-pool-2", tier: "standard" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(vpsAdopter).not.toHaveBeenCalled();
      expect(vpsProvisioner).toHaveBeenCalledWith({
        businessId: "biz-pool-2",
        tier: "standard",
        vpsSize: "kvm2",
        billingPeriod: null
      });
      expect(pool.record).toHaveBeenCalledWith(
        expect.objectContaining({
          vmId: 123,
          plan: "kvm2",
          businessId: "biz-pool-2",
          // The purchased Hostinger term is recorded for pool triage — no
          // billingPeriod on the input means the monthly SKU was bought.
          notes: "purchased for biz-pool-2 (1m term)"
        })
      );
    });

    it("skipPoolAdopt forces a term purchase past an available pooled box (change-plan term alignment)", async () => {
      // A pooled same-size box IS available, but the caller (the change-plan
      // term-alignment migration) must land on a term-priced PURCHASE — a
      // pooled monthly lapser would defeat the point of the move.
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const vpsAdopter = vi.fn();
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("777"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-skip", tier: "starter", billingPeriod: "biennial", skipPoolAdopt: true },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(result.vpsId).toBe("777");
      expect(pool.claim).not.toHaveBeenCalled();
      expect(vpsAdopter).not.toHaveBeenCalled();
      expect(vpsProvisioner).toHaveBeenCalledWith({
        businessId: "biz-pool-skip",
        tier: "starter",
        vpsSize: "kvm1",
        billingPeriod: "biennial"
      });
      // The new box is still recorded as assigned inventory, tagged with
      // the 2-year term it was bought at.
      expect(pool.record).toHaveBeenCalledWith(
        expect.objectContaining({
          vmId: 777,
          businessId: "biz-pool-skip",
          notes: "purchased for biz-pool-skip (2y term)"
        })
      );
    });

    it("falls back to purchase when the pool claim itself throws", async () => {
      const pool = makePool({ claim: vi.fn().mockRejectedValue(new Error("pool db down")) });
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-3", tier: "starter" },
        { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, remoteExec }
      );

      expect(result.vpsId).toBe("123");
      expect(vpsProvisioner).toHaveBeenCalled();
    });

    it("stringifies a non-Error pool claim failure and still purchases", async () => {
      const pool = makePool({ claim: vi.fn().mockRejectedValue("claim string boom") });
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-3b", tier: "starter" },
        { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("123");
    });

    it("retires the claimed box and purchases when the adopt fails", async () => {
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const vpsAdopter = vi.fn().mockRejectedValue(new Error("recreate 422"));
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-4", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(result.vpsId).toBe("123");
      expect(pool.retire).toHaveBeenCalledWith(
        1800985,
        expect.stringContaining("adopt failed for biz-pool-4: recreate 422")
      );
      // The replacement purchase is still recorded as inventory.
      expect(pool.record).toHaveBeenCalledWith(
        expect.objectContaining({ vmId: 123, businessId: "biz-pool-4" })
      );
    });

    it("stringifies a non-Error adopt failure in the retire reason", async () => {
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const vpsAdopter = vi.fn().mockRejectedValue("adopt string boom");
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-pool-4b", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );
      expect(pool.retire).toHaveBeenCalledWith(
        1800985,
        expect.stringContaining("adopt string boom")
      );
    });

    it("continues to purchase when the retire after a failed adopt also fails", async () => {
      const pool = makePool({
        claim: vi.fn().mockResolvedValue(claimedRow),
        retire: vi.fn().mockRejectedValue(new Error("retire boom"))
      });
      const vpsAdopter = vi.fn().mockRejectedValue(new Error("adopt boom"));
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-5", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("123");
    });

    it("stringifies a non-Error retire failure and still purchases", async () => {
      const pool = makePool({
        claim: vi.fn().mockResolvedValue(claimedRow),
        retire: vi.fn().mockRejectedValue("retire string boom")
      });
      const vpsAdopter = vi.fn().mockRejectedValue(new Error("adopt boom"));
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-5b", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("123");
    });

    it("continues when post-adopt inventory bookkeeping fails", async () => {
      const pool = makePool({
        claim: vi.fn().mockResolvedValue(claimedRow),
        record: vi.fn().mockRejectedValue(new Error("record boom"))
      });
      const vpsAdopter = vi.fn().mockResolvedValue(makeVpsStub("1800985"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-6", tier: "starter" },
        { vpsProvisioner: vi.fn(), vpsAdopter, vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("1800985");
    });

    it("stringifies a non-Error post-adopt bookkeeping failure", async () => {
      const pool = makePool({
        claim: vi.fn().mockResolvedValue(claimedRow),
        record: vi.fn().mockRejectedValue("record string boom")
      });
      const vpsAdopter = vi.fn().mockResolvedValue(makeVpsStub("1800985"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-6b", tier: "starter" },
        { vpsProvisioner: vi.fn(), vpsAdopter, vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("1800985");
    });

    it("continues when post-purchase inventory bookkeeping fails", async () => {
      const pool = makePool({ record: vi.fn().mockRejectedValue(new Error("record boom")) });
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-7", tier: "starter" },
        { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("123");
    });

    it("stringifies a non-Error post-purchase bookkeeping failure", async () => {
      const pool = makePool({ record: vi.fn().mockRejectedValue("record string boom") });
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-7b", tier: "starter" },
        { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, remoteExec }
      );
      expect(result.vpsId).toBe("123");
    });

    it("runs the stale-tenant cascade after a successful adopt (admin release-to-pool flow)", async () => {
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const vpsAdopter = vi.fn().mockResolvedValue(makeVpsStub("1800985"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-pool-cascade", tier: "starter" },
        { vpsProvisioner: vi.fn(), vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(cleanupStaleTenantsForVm).toHaveBeenCalledWith({
        vmId: 1800985,
        newBusinessId: "biz-pool-cascade"
      });
    });

    it("does NOT run the stale-tenant cascade on the purchase path", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      await orchestrateProvisioning(
        { businessId: "biz-pool-no-cascade", tier: "starter" },
        { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, remoteExec }
      );

      expect(cleanupStaleTenantsForVm).not.toHaveBeenCalled();
    });

    it("continues the provision when the stale-tenant cascade throws (Error)", async () => {
      vi.mocked(cleanupStaleTenantsForVm).mockRejectedValueOnce(new Error("cleanup boom"));
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const vpsAdopter = vi.fn().mockResolvedValue(makeVpsStub("1800985"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-cascade-fail", tier: "starter" },
        { vpsProvisioner: vi.fn(), vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(result.vpsId).toBe("1800985");
    });

    it("stringifies a non-Error stale-tenant cascade failure and continues", async () => {
      vi.mocked(cleanupStaleTenantsForVm).mockRejectedValueOnce("cleanup string boom");
      const pool = makePool({ claim: vi.fn().mockResolvedValue(claimedRow) });
      const vpsAdopter = vi.fn().mockResolvedValue(makeVpsStub("1800985"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-cascade-nonerr", tier: "starter" },
        { vpsProvisioner: vi.fn(), vpsAdopter, vpsPool: pool, remoteExec }
      );

      expect(result.vpsId).toBe("1800985");
    });

    it("skips the pool entirely when vpsPool is null (break-glass)", async () => {
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("123"));
      const vpsAdopter = vi.fn();
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-pool-8", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: null, remoteExec }
      );

      expect(result.vpsId).toBe("123");
      expect(vpsAdopter).not.toHaveBeenCalled();
    });
  });

  describe("fail-but-charge orphan reconciliation", () => {
    function makePool(overrides: Record<string, unknown> = {}) {
      return {
        claim: vi.fn().mockResolvedValue(null),
        record: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
        retire: vi.fn().mockResolvedValue(undefined),
        ...overrides
      };
    }

    /**
     * The exact failure shape from the Jul 8 2026 Truly Insurance signup:
     * the PURCHASE endpoint threw 402 "Card payment could not be completed"
     * while Hostinger charged the card and created VM 1815606 anyway.
     */
    class FakePurchaseError extends Error {
      readonly endpoint = "/api/vps/v1/virtual-machines";
      readonly status = 402;
      readonly body = { message: "Card payment could not be completed" };
      constructor() {
        super("Hostinger API HTTP 402: Card payment could not be completed");
        this.name = "HostingerApiError";
      }
    }

    const orphanRow = {
      vm_id: 1815606,
      hostname: "srv1815606.hstgr.cloud",
      plan: "kvm1",
      state: "assigned",
      hostinger_billing_subscription_id: "hsub-orphan",
      assigned_business_id: "biz-orphan-adopt",
      acquired_at: "2026-07-08T22:52:20Z",
      assigned_at: "2026-07-08T22:57:37Z",
      notes: null,
      updated_at: "2026-07-08T22:57:37Z"
    };

    it("adopts the reconciled orphan when the purchase fails-but-charges (self-heal)", async () => {
      // First claim (adopt-first, pool empty) misses; second claim (after
      // reconciliation pooled the orphan) hits.
      const pool = makePool({
        claim: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(orphanRow)
      });
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      const vpsAdopter = vi.fn().mockResolvedValue({
        ...makeVpsStub("1815606"),
        hostingerBillingSubscriptionId: "hsub-orphan"
      });
      const orphanReconciler = vi
        .fn()
        .mockResolvedValue([{ vmId: 1815606, plan: "kvm1" }]);
      const remoteExec = vi.fn().mockResolvedValue(okExec());

      const result = await orchestrateProvisioning(
        { businessId: "biz-orphan-adopt", tier: "starter" },
        { vpsProvisioner, vpsAdopter, vpsPool: pool, orphanReconciler, remoteExec }
      );

      expect(result.vpsId).toBe("1815606");
      expect(orphanReconciler).toHaveBeenCalledTimes(1);
      expect(vpsAdopter).toHaveBeenCalledWith(
        expect.objectContaining({ virtualMachineId: 1815606 })
      );
      // Only ONE purchase attempt — the whole point is not buying twice.
      expect(vpsProvisioner).toHaveBeenCalledTimes(1);
    });

    it("rethrows the original purchase error when the reconciler finds nothing", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      const orphanReconciler = vi.fn().mockResolvedValue([]);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-none", tier: "starter" },
          { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
      expect(orphanReconciler).toHaveBeenCalledTimes(1);
    });

    it("rethrows when the reconciled orphan's size does not match the requested size", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      // Orphan is a kvm8; the starter provision needs kvm1 — no adopt.
      const orphanReconciler = vi.fn().mockResolvedValue([{ vmId: 999, plan: "kvm8" }]);
      const vpsAdopter = vi.fn();

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-mismatch", tier: "starter" },
          { vpsProvisioner, vpsAdopter, vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
      expect(vpsAdopter).not.toHaveBeenCalled();
    });

    it("does NOT reconcile on non-purchase-endpoint Hostinger failures", async () => {
      class FakePisError extends Error {
        readonly endpoint = "/api/vps/v1/post-install-scripts";
        readonly status = 500;
        readonly body = null;
        constructor() {
          super("Hostinger API HTTP 500");
          this.name = "HostingerApiError";
        }
      }
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePisError());
      const orphanReconciler = vi.fn();

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-wrong-endpoint", tier: "starter" },
          { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 500/);
      expect(orphanReconciler).not.toHaveBeenCalled();
    });

    it("does NOT reconcile on generic (non-Hostinger) purchase errors", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new Error("kapow"));
      const orphanReconciler = vi.fn();

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-generic-err", tier: "starter" },
          { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow("kapow");
      expect(orphanReconciler).not.toHaveBeenCalled();
    });

    it("skipPoolAdopt: pools the orphan (bookkeeping) but does not adopt it", async () => {
      // Change-plan term alignment must land on a term-priced PURCHASE; the
      // orphan still gets pooled so it isn't lost, but no adopt happens and
      // the original error surfaces for the operator.
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      const orphanReconciler = vi.fn().mockResolvedValue([{ vmId: 1815606, plan: "kvm1" }]);
      const vpsAdopter = vi.fn();

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-skip", tier: "starter", skipPoolAdopt: true },
          { vpsProvisioner, vpsAdopter, vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
      expect(orphanReconciler).toHaveBeenCalledTimes(1);
      expect(vpsAdopter).not.toHaveBeenCalled();
      expect(pool.claim).not.toHaveBeenCalled();
    });

    it("surfaces the original purchase error when the reconciler itself throws", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      const orphanReconciler = vi.fn().mockRejectedValue(new Error("hostinger list also down"));

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-reconcile-fail", tier: "starter" },
          { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
    });

    it("stringifies a non-Error reconciler rejection and surfaces the original error", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      const orphanReconciler = vi.fn().mockRejectedValue("reconcile string boom");

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-reconcile-nonerr", tier: "starter" },
          { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
    });

    it("rethrows when the post-reconcile adopt also fails (orphan retired, no loop)", async () => {
      const pool = makePool({
        claim: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(orphanRow)
      });
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());
      const vpsAdopter = vi.fn().mockRejectedValueOnce(new Error("setup 422"));
      const orphanReconciler = vi.fn().mockResolvedValue([{ vmId: 1815606, plan: "kvm1" }]);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-adopt-fail", tier: "starter" },
          { vpsProvisioner, vpsAdopter, vpsPool: pool, orphanReconciler, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
      // The bad orphan was retired, and crucially NO second purchase happened.
      expect(pool.retire).toHaveBeenCalledWith(1815606, expect.stringContaining("setup 422"));
      expect(vpsProvisioner).toHaveBeenCalledTimes(1);
    });

    it("disables reconciliation entirely when orphanReconciler is null", async () => {
      const pool = makePool();
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakePurchaseError());

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-orphan-disabled", tier: "starter" },
          { vpsProvisioner, vpsAdopter: vi.fn(), vpsPool: pool, orphanReconciler: null, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 402/);
    });
  });

  describe("failure recording", () => {
    /**
     * Regression for the production failure where `brianlanefanmail@gmail.com`
     * sat at "Provisioning started 5%" forever after the Hostinger API
     * returned 403 on `POST /api/vps/v1/post-install-scripts` (token missing
     * the post-install-scripts scope). The orchestrator's vpsProvisioner
     * call was unprotected, so the throw bubbled up to the webhook caller
     * and the dashboard — which polls the latest `coworker_logs` row —
     * never saw a terminal failure. The fix wraps the orchestrator body
     * in a top-level try/catch that records a `phase: "failed"` row with
     * `status: "error"` so `shouldMountProvisioningWidget` flips into its
     * terminal-failure UI.
     */
    it("records a `failed` progress row with status:error when vpsProvisioner throws", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();

      const boom = new Error("kapow");
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(boom);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-fail-1", tier: "starter" },
          { vpsProvisioner, remoteExec: vi.fn() }
        )
      ).rejects.toThrow("kapow");

      const failed = recordMock.mock.calls
        .map((c) => c[0])
        .find((p) => p.phase === "failed");
      expect(failed).toBeDefined();
      expect(failed?.status).toBe("error");
      expect(failed?.businessId).toBe("biz-fail-1");
      expect(failed?.message).toMatch(/kapow/);
      // The first row recorded is still the `started` row at 5% — the
      // catch block doesn't suppress the upfront recording, only adds
      // a terminal `failed` row after.
      expect(recordMock.mock.calls[0][0].phase).toBe("started");
    });

    it("includes endpoint, status, and body in the failure message when the error is a HostingerApiError", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();

      // We don't import HostingerApiError directly to keep this test
      // decoupled from the client module shape. The orchestrator's
      // `describeProvisioningError` checks `err.name === "HostingerApiError"`
      // duck-typed for the same reason — see the docstring there.
      class FakeHostingerApiError extends Error {
        readonly endpoint = "/api/vps/v1/post-install-scripts";
        readonly status = 403;
        readonly body = {
          message: "[VPS:2000] Unauthorized",
          correlation_id: "abc-123"
        };
        constructor() {
          super("Hostinger API HTTP 403: [VPS:2000] Unauthorized");
          this.name = "HostingerApiError";
        }
      }

      const vpsProvisioner = vi.fn().mockRejectedValueOnce(new FakeHostingerApiError());

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-fail-2", tier: "standard" },
          { vpsProvisioner, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/HTTP 403/);

      const failed = recordMock.mock.calls
        .map((c) => c[0])
        .find((p) => p.phase === "failed");
      expect(failed?.message).toContain("/api/vps/v1/post-install-scripts");
      expect(failed?.message).toContain("403");
      expect(failed?.message).toContain("[VPS:2000] Unauthorized");
    });

    it("does not mask the original error when the failure-row write itself fails", async () => {
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();

      // First call (the upfront `started` row) succeeds, second call (the
      // catch-block `failed` row) blows up. The orchestrator must still
      // surface the *original* error to the caller — losing the original
      // error to a logging-time failure is the bug we're guarding against.
      recordMock.mockResolvedValueOnce({} as never);
      recordMock.mockRejectedValueOnce(new Error("supabase down"));

      const original = new Error("the real failure");
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(original);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-fail-3", tier: "starter" },
          { vpsProvisioner, remoteExec: vi.fn() }
        )
      ).rejects.toThrow("the real failure");
    });

    it("stringifies non-Error rejections from the failure-row write", async () => {
      // Companion to the previous test: covers the `String(logErr)` half
      // of the `logErr instanceof Error ? logErr.message : String(logErr)`
      // guard inside the catch-block's logger.warn. Without this, a
      // non-Error rejection (string, number, undefined) from the
      // coworker_logs insert would fall through `instanceof Error` checks
      // upstream and could surface as `[object Object]` in logs.
      const recordMock = vi.mocked(recordProvisioningProgress);
      recordMock.mockClear();

      recordMock.mockResolvedValueOnce({} as never);
      recordMock.mockRejectedValueOnce("supabase string-thrown");

      const original = new Error("real failure 2");
      const vpsProvisioner = vi.fn().mockRejectedValueOnce(original);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-fail-4", tier: "starter" },
          { vpsProvisioner, remoteExec: vi.fn() }
        )
      ).rejects.toThrow("real failure 2");
    });
  });

  describe("provider axis (BYOS / OVH)", () => {
    it("byos enterprise: provisions via the injected provisioner and never touches the Hostinger pool", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "enterprise",
        vps_provider: "byos",
        data_residency_mode: "dual"
      } as never);
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("777"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());
      const vpsPool = {
        claim: vi.fn(),
        record: vi.fn(),
        release: vi.fn(),
        retire: vi.fn()
      };

      const result = await orchestrateProvisioning(
        { businessId: "biz-byos-1", tier: "enterprise", ownerEmail: "o@test.com" },
        { vpsProvisioner, remoteExec, vpsPool }
      );

      expect(result.vpsId).toBe("777");
      // The vps_inventory pool is Hostinger stock: a BYOS provision must
      // neither adopt from it nor record into it.
      expect(vpsPool.claim).not.toHaveBeenCalled();
      expect(vpsPool.record).not.toHaveBeenCalled();
    });

    it("rejects a non-hostinger provider on a non-enterprise tenant (tier gate)", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "standard",
        vps_provider: "byos"
      } as never);
      const vpsProvisioner = vi.fn();

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-byos-2", tier: "standard" },
          { vpsProvisioner, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/Enterprise plan features/);
      expect(vpsProvisioner).not.toHaveBeenCalled();
    });

    it("byos with residency still 'supabase' is refused before anything is purchased (compliance gate)", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "enterprise",
        vps_provider: "byos",
        data_residency_mode: "supabase"
      } as never);
      const vpsProvisioner = vi.fn();
      await expect(
        orchestrateProvisioning(
          { businessId: "biz-byos-res", tier: "enterprise" },
          { vpsProvisioner, remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/Flip data residency to 'dual' first/);
      expect(vpsProvisioner).not.toHaveBeenCalled();
    });

    it("canada-region (ovh/ca) placements are also residency-gated", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "enterprise",
        vps_provider: "ovh",
        vps_region: "ca"
        // data_residency_mode missing → 'supabase'
      } as never);
      await expect(
        orchestrateProvisioning(
          { businessId: "biz-ovh-res", tier: "enterprise" },
          { vpsProvisioner: vi.fn(), remoteExec: vi.fn() }
        )
      ).rejects.toThrow(/Canadian-region box/);
    });

    it("byos without an injected provisioner fails loudly instead of buying a Hostinger box", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "enterprise",
        vps_provider: "byos",
        data_residency_mode: "dual"
      } as never);

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-byos-3", tier: "enterprise" },
          { remoteExec: vi.fn(), vpsPool: null }
        )
      ).rejects.toThrow(/No default VPS provisioner for provider 'byos'.*SSH-handover/);
    });

    it("ovh without an injected provisioner routes to the lazy OVH default (env-gated)", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "enterprise",
        vps_provider: "ovh"
      } as never);
      // No OVH_* env in the test process: the lazy default constructs the
      // client on first call and fails THIS provision loudly with the
      // missing-env message (instead of silently buying a Hostinger box).
      delete process.env.OVH_APP_KEY;
      delete process.env.OVH_APP_SECRET;
      delete process.env.OVH_CONSUMER_KEY;

      await expect(
        orchestrateProvisioning(
          { businessId: "biz-ovh-1", tier: "enterprise" },
          { remoteExec: vi.fn(), vpsPool: null }
        )
      ).rejects.toThrow(/OVH client requires OVH_APP_KEY/);
    });

    it("ovh with an injected provisioner provisions without touching the Hostinger pool", async () => {
      vi.mocked(getBusiness).mockResolvedValue({
        business_type: "real_estate",
        tier: "enterprise",
        vps_provider: "ovh"
      } as never);
      const vpsProvisioner = vi.fn().mockResolvedValue(makeVpsStub("888"));
      const remoteExec = vi.fn().mockResolvedValue(okExec());
      const vpsPool = { claim: vi.fn(), record: vi.fn(), release: vi.fn(), retire: vi.fn() };

      const result = await orchestrateProvisioning(
        { businessId: "biz-ovh-2", tier: "enterprise", ownerEmail: "o@test.com" },
        { vpsProvisioner, remoteExec, vpsPool }
      );
      expect(result.vpsId).toBe("888");
      expect(vpsPool.claim).not.toHaveBeenCalled();
      expect(vpsPool.record).not.toHaveBeenCalled();
    });
  });
});
