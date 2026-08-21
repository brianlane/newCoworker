import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
type BusinessRowResult = {
  data: { tier: string; vps_size: string | null } | null;
  error: { message: string } | null;
};
const businessRowMock = vi.fn(
  async (): Promise<BusinessRowResult> => ({
    data: { tier: "standard", vps_size: "kvm2" },
    error: null
  })
);
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    rpc: rpcMock,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: businessRowMock }) })
    })
  }))
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyGatewayTokenForBusiness: vi.fn()
}));

vi.mock("@/lib/db/vps-posture", () => ({
  insertVpsPostureReport: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/vps/posture/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { insertVpsPostureReport } from "@/lib/db/vps-posture";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/vps/posture", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer per-tenant-token"
    },
    body: JSON.stringify(body)
  });
}

const passingChecks = [
  { name: "ufw_active", ok: true, detail: "ufw active" },
  { name: "ssh_password_auth_disabled", ok: true }
];

describe("api/vps/posture route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(insertVpsPostureReport).mockResolvedValue({
      id: "rep-1",
      business_id: BIZ_ID,
      ok: true,
      checks: [],
      metrics: null,
      created_at: "2026-07-08T00:00:00Z"
    });
    rpcMock.mockResolvedValue({ data: null, error: null });
    businessRowMock.mockResolvedValue({
      data: { tier: "standard", vps_size: "kvm2" },
      error: null
    });
  });

  it("persists a passing report without emitting telemetry", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ received: true, ok: true });
    expect(insertVpsPostureReport).toHaveBeenCalledWith({
      businessId: BIZ_ID,
      ok: true,
      checks: passingChecks,
      metrics: null
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("stores a well-formed host metrics aggregate", async () => {
    const metrics = {
      cpuCount: 2,
      load1Max: 2.9,
      load1Mean: 1.31,
      memAvailableMinMib: 2001,
      memTotalMib: 7940,
      swapUsedMaxMib: 200,
      samples: 30
    };
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks, metrics }));
    expect(res.status).toBe(200);
    expect(insertVpsPostureReport).toHaveBeenCalledWith(
      expect.objectContaining({ metrics })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a busy box is not posture drift", async () => {
    // Metrics ride ALONGSIDE the checks, never as one: the route ANDs checks
    // into `ok` and emits vps_posture_drift on a failure, and a loaded box is
    // a capacity signal, not a security finding.
    const res = await POST(
      makeRequest({
        businessId: BIZ_ID,
        checks: passingChecks,
        metrics: {
          cpuCount: 2,
          load1Max: 14.2,
          load1Mean: 11.8,
          memAvailableMinMib: 40,
          memTotalMib: 7940,
          swapUsedMaxMib: 3900,
          samples: 30
        }
      })
    );
    expect((await res.json()).data.ok).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("stores null and warns when the metrics block is malformed", async () => {
    const res = await POST(
      makeRequest({
        businessId: BIZ_ID,
        checks: passingChecks,
        metrics: { cpuCount: 2, load1Max: 1.0 }
      })
    );
    expect(res.status).toBe(200);
    expect(insertVpsPostureReport).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: null })
    );
    // Silence here would make a box shipping garbage indistinguishable from a
    // box too old to send metrics at all.
    expect(logger.warn).toHaveBeenCalledWith(
      "VPS posture metrics rejected as malformed",
      { businessId: BIZ_ID }
    );
  });

  it("accepts a report from a box whose heartbeat predates metrics", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks }));
    expect(res.status).toBe(200);
    expect(insertVpsPostureReport).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: null })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("drift persists ok=false, warns, and emits vps_posture_drift telemetry", async () => {
    const drift = [
      { name: "ufw_active", ok: false, detail: "ufw inactive" },
      { name: "fail2ban_active", ok: true }
    ];
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: drift }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "VPS posture drift reported",
      expect.objectContaining({ failed: ["ufw_active"] })
    );
    expect(rpcMock).toHaveBeenCalledWith("telemetry_record", {
      p_event_type: "vps_posture_drift",
      p_payload: expect.objectContaining({
        business_id: BIZ_ID,
        failed: [{ name: "ufw_active", detail: "ufw inactive" }]
      })
    });
  });

  it("a telemetry RPC failure never rejects the box's report", async () => {
    rpcMock.mockRejectedValue(new Error("rpc down"));
    const res = await POST(
      makeRequest({
        businessId: BIZ_ID,
        checks: [{ name: "ufw_active", ok: false }]
      })
    );
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "vps_posture_drift telemetry emit failed",
      expect.objectContaining({ error: "rpc down" })
    );
  });

  it("401s on an unbound gateway token", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(false);
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks }));
    expect(res.status).toBe(401);
    expect(insertVpsPostureReport).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies (missing checks, empty array)", async () => {
    const missing = await POST(makeRequest({ businessId: BIZ_ID }));
    expect(missing.status).toBe(400);

    const empty = await POST(makeRequest({ businessId: BIZ_ID, checks: [] }));
    expect(empty.status).toBe(400);
    expect(insertVpsPostureReport).not.toHaveBeenCalled();
  });
});

/**
 * bootstrap.sh runs once, at provision. Editing it reaches new boxes and
 * nothing else, and every fleet rollout refreshes the repo and containers
 * WITHOUT re-running it. So a setting can be correct in the repo, green in
 * CI, deployed to main, and absent from every live box, with nothing
 * reporting a problem. The KVM 2 `OLLAMA_CONTEXT_LENGTH` gap survived a
 * month exactly that way. This closes it by comparing the box's LIVE Ollama
 * process against what bootstrap would write for its size.
 */
describe("api/vps/posture bootstrap drift check", () => {
  const KVM2_ENV = {
    OLLAMA_NUM_PARALLEL: "1",
    OLLAMA_MAX_LOADED_MODELS: "1",
    OMP_NUM_THREADS: "2",
    OLLAMA_HOST: "0.0.0.0:11434",
    OLLAMA_CONTEXT_LENGTH: "8192",
    OLLAMA_KV_CACHE_TYPE: "q4_0",
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KEEP_ALIVE: "-1"
  };

  function checksFromLastInsert(): Array<{ name: string; ok: boolean; detail?: string }> {
    return vi.mocked(insertVpsPostureReport).mock.calls.at(-1)?.[0].checks ?? [];
  }

  // This block needs its own setup: a `beforeEach` belongs to the describe
  // that declares it, so without this these tests would inherit whatever
  // mock state the previous describe (and each preceding sibling) happened
  // to leave behind. Several tests below deliberately swap the business row
  // out, so that leakage would make them order-dependent.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
    vi.mocked(insertVpsPostureReport).mockResolvedValue({
      id: "rep-1",
      business_id: BIZ_ID,
      ok: true,
      checks: [],
      metrics: null,
      created_at: "2026-07-08T00:00:00Z"
    });
    rpcMock.mockResolvedValue({ data: null, error: null });
    businessRowMock.mockResolvedValue({
      data: { tier: "standard", vps_size: "kvm2" },
      error: null
    });
  });

  it("passes a box that matches its size's bootstrap tuning", async () => {
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, checks: passingChecks, ollamaEnv: KVM2_ENV })
    );
    expect((await res.json()).data.ok).toBe(true);
    expect(checksFromLastInsert()).toContainEqual({
      name: "ollama_tuning_matches_bootstrap",
      ok: true,
      detail: "matches kvm2 bootstrap tuning"
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("fails and alerts when the live process lost a setting", async () => {
    const { OLLAMA_CONTEXT_LENGTH: _gone, ...drifted } = KVM2_ENV;
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, checks: passingChecks, ollamaEnv: drifted })
    );
    expect((await res.json()).data.ok).toBe(false);
    const check = checksFromLastInsert().find(
      (c) => c.name === "ollama_tuning_matches_bootstrap"
    );
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("OLLAMA_CONTEXT_LENGTH is unset, expected 8192");
    // Rides the existing drift alerting rather than inventing a new channel.
    expect(rpcMock).toHaveBeenCalledWith(
      "telemetry_record",
      expect.objectContaining({ p_event_type: "vps_posture_drift" })
    );
  });

  it("adds no check at all for a kvm1 box, which ships no Ollama", async () => {
    businessRowMock.mockResolvedValue({
      data: { tier: "enterprise", vps_size: "kvm1" },
      error: null
    });
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, checks: passingChecks, ollamaEnv: {} })
    );
    expect((await res.json()).data.ok).toBe(true);
    expect(checksFromLastInsert().map((c) => c.name)).not.toContain(
      "ollama_tuning_matches_bootstrap"
    );
  });

  it("treats a readable-but-empty environment as fully drifted", async () => {
    // The box read the process and found NO tuning at all. That is the most
    // broken state there is, and it must not look like "not measured".
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, checks: passingChecks, ollamaEnv: {} })
    );
    expect((await res.json()).data.ok).toBe(false);
    const check = checksFromLastInsert().find(
      (c) => c.name === "ollama_tuning_matches_bootstrap"
    );
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("OLLAMA_CONTEXT_LENGTH is unset");
    expect(check?.detail).toContain("OLLAMA_HOST is unset");
  });

  it("adds no check when the box reports no ollamaEnv", async () => {
    // Every box runs a heartbeat that predates this block until redeployed.
    const res = await POST(makeRequest({ businessId: BIZ_ID, checks: passingChecks }));
    expect((await res.json()).data.ok).toBe(true);
    expect(checksFromLastInsert().map((c) => c.name)).not.toContain(
      "ollama_tuning_matches_bootstrap"
    );
  });

  it("adds no check when the business row cannot be read", async () => {
    // Guessing a size would either invent drift or quietly certify a box as
    // matching. "We could not tell" must never render as "it matches".
    businessRowMock.mockResolvedValue({ data: null, error: { message: "down" } });
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, checks: passingChecks, ollamaEnv: KVM2_ENV })
    );
    expect((await res.json()).data.ok).toBe(true);
    expect(checksFromLastInsert().map((c) => c.name)).not.toContain(
      "ollama_tuning_matches_bootstrap"
    );
  });

  it("survives a thrown business lookup", async () => {
    businessRowMock.mockRejectedValue(new Error("boom"));
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, checks: passingChecks, ollamaEnv: KVM2_ENV })
    );
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "VPS posture business lookup failed",
      expect.objectContaining({ error: "boom" })
    );
  });

  it("rejects a non-string env map", async () => {
    const res = await POST(
      makeRequest({
        businessId: BIZ_ID,
        checks: passingChecks,
        ollamaEnv: { OLLAMA_CONTEXT_LENGTH: 8192 }
      })
    );
    expect(res.status).toBe(400);
  });
});
