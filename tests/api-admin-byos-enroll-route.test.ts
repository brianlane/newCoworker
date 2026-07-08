import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn()
}));

vi.mock("@/lib/provisioning/byos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provisioning/byos")>();
  return {
    ...actual,
    prepareByosEnrollment: vi.fn(),
    probeByosSsh: vi.fn(),
    makeByosProvisioner: vi.fn(() => "byos-provisioner-stub")
  };
});

vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn()
}));

vi.mock("@/lib/provisioning/progress", () => ({
  getLatestProvisioningStatus: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/admin/byos/enroll/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  ByosEnrollmentError,
  prepareByosEnrollment,
  probeByosSsh
} from "@/lib/provisioning/byos";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";
import { VpsProviderValidationError } from "@/lib/vps/provider";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/byos/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("api/admin/byos/enroll route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      tier: "enterprise",
      owner_email: "owner@example.com",
      vps_size: null
    } as never);
    vi.mocked(getSubscription).mockResolvedValue({ billing_period: "monthly" } as never);
    vi.mocked(prepareByosEnrollment).mockResolvedValue({
      publicKey: "ssh-ed25519 AAAA byos",
      fingerprintSha256: "SHA256:fp",
      host: "203.0.113.7",
      region: "ca",
      reusedExistingKey: false
    });
    vi.mocked(probeByosSsh).mockResolvedValue({ host: "203.0.113.7" });
    vi.mocked(getLatestProvisioningStatus).mockResolvedValue(null);
    vi.mocked(orchestrateProvisioning).mockResolvedValue({
      vpsId: "byos-x",
      tunnelUrl: "https://x",
      hostingerBillingSubscriptionId: null
    });
  });

  it("prepare: mints the key and returns the public half", async () => {
    const res = await POST(
      makeRequest({ action: "prepare", businessId: BIZ_ID, host: "203.0.113.7", region: "ca" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.publicKey).toContain("ssh-ed25519");
    expect(prepareByosEnrollment).toHaveBeenCalledWith({
      businessId: BIZ_ID,
      host: "203.0.113.7",
      region: "ca"
    });
  });

  it("provision: probes SSH synchronously, then kicks the orchestrator in the background", async () => {
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ started: true, host: "203.0.113.7" });
    expect(probeByosSsh).toHaveBeenCalledWith(BIZ_ID);
    expect(orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ_ID,
        tier: "enterprise",
        billingPeriod: "monthly",
        ownerEmail: "owner@example.com"
      }),
      { vpsProvisioner: "byos-provisioner-stub" }
    );
  });

  it("provision: a background orchestrator failure is logged, not thrown", async () => {
    vi.mocked(orchestrateProvisioning).mockRejectedValue(new Error("bootstrap failed"));
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(logger.error).toHaveBeenCalledWith(
      "BYOS provisioning run failed",
      expect.objectContaining({ error: "bootstrap failed" })
    );
  });

  it("provision: a non-Error background rejection is stringified", async () => {
    vi.mocked(orchestrateProvisioning).mockRejectedValue("plain failure");
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(logger.error).toHaveBeenCalledWith(
      "BYOS provisioning run failed",
      expect.objectContaining({ error: "plain failure" })
    );
  });

  it("provision: 409s while a recent run is still in flight (double-click guard)", async () => {
    vi.mocked(getLatestProvisioningStatus).mockResolvedValue({
      percent: 40,
      phase: "remote_deploy_starting",
      logStatus: "thinking",
      updatedAt: new Date().toISOString()
    });
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.message).toContain("already in progress");
    expect(probeByosSsh).not.toHaveBeenCalled();
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("provision: a stale or terminal previous run does not block a retry", async () => {
    // Stale thinking row (crashed run > 30 min ago) — retry allowed.
    vi.mocked(getLatestProvisioningStatus).mockResolvedValueOnce({
      percent: 40,
      phase: "remote_deploy_starting",
      logStatus: "thinking",
      updatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString()
    });
    const stale = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(stale.status).toBe(200);

    // Terminal error row — retry allowed.
    vi.mocked(getLatestProvisioningStatus).mockResolvedValueOnce({
      percent: 95,
      phase: "deploy_failed",
      logStatus: "error",
      updatedAt: new Date().toISOString()
    });
    const failed = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(failed.status).toBe(200);
  });

  it("provision: probe failure surfaces as a 400 with the hint", async () => {
    vi.mocked(probeByosSsh).mockRejectedValue(
      new ByosEnrollmentError("SSH probe to 203.0.113.7 failed: ECONNREFUSED")
    );
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("SSH probe");
    expect(orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("prepare: tier-gate rejection surfaces as a 400", async () => {
    vi.mocked(prepareByosEnrollment).mockRejectedValue(
      new VpsProviderValidationError("Bring-your-own-server is enterprise-only.")
    );
    const res = await POST(
      makeRequest({ action: "prepare", businessId: BIZ_ID, host: "203.0.113.7", region: "us" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("enterprise-only");
  });

  it("rejects malformed bodies and unknown actions", async () => {
    const missingHost = await POST(makeRequest({ action: "prepare", businessId: BIZ_ID }));
    expect(missingHost.status).toBe(400);

    const badAction = await POST(makeRequest({ action: "destroy", businessId: BIZ_ID }));
    expect(badAction.status).toBe(400);
    expect(prepareByosEnrollment).not.toHaveBeenCalled();
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(404);
    expect(probeByosSsh).not.toHaveBeenCalled();
  });

  it("403s when the caller is not an admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      Object.assign(new Error("Admin access required"), { status: 403 })
    );
    const res = await POST(makeRequest({ action: "provision", businessId: BIZ_ID }));
    expect(res.status).toBe(403);
  });

  it("unexpected failures collapse to a 500", async () => {
    vi.mocked(prepareByosEnrollment).mockRejectedValue(new Error("db exploded"));
    const res = await POST(
      makeRequest({ action: "prepare", businessId: BIZ_ID, host: "203.0.113.7", region: "us" })
    );
    expect(res.status).toBe(500);
  });
});
