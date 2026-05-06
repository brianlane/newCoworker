import { beforeEach, describe, expect, it, vi } from "vitest";

const assertCronAuthSpy = vi.fn();
vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: (...args: unknown[]) => assertCronAuthSpy(...args)
}));

const listSpy = vi.fn();
vi.mock("@/lib/db/telnyx-routes", () => ({
  listBusinessesPendingTendlcAttach: (...args: unknown[]) => listSpy(...args)
}));

const attachSpy = vi.fn();
const readConfigSpy = vi.fn();
vi.mock("@/lib/provisioning/tendlc-attach", () => {
  // Defined inside the factory because vi.mock is hoisted ABOVE all
  // top-level lets/consts; capturing a top-level `class` here would
  // fire a TDZ ReferenceError at hoist time.
  class FakeMissingTendlcConfigError extends Error {
    public readonly missing: string[];
    constructor(missing: string[]) {
      super(`missing: ${missing.join(",")}`);
      this.missing = missing;
    }
  }
  return {
    attachBusinessDidToCampaign: (...args: unknown[]) => attachSpy(...args),
    readTendlcConfig: (...args: unknown[]) => readConfigSpy(...args),
    MissingTendlcConfigError: FakeMissingTendlcConfigError
  };
});

import { MissingTendlcConfigError as MockedMissingTendlcConfigError } from "@/lib/provisioning/tendlc-attach";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

import { POST } from "@/app/api/internal/tendlc-attach-retry/route";

function makeRequest() {
  return new Request("http://localhost/api/internal/tendlc-attach-retry", {
    method: "POST",
    headers: { Authorization: "Bearer secret" }
  });
}

beforeEach(() => {
  assertCronAuthSpy.mockReset();
  listSpy.mockReset();
  attachSpy.mockReset();
  readConfigSpy.mockReset();
  // Default: cron auth passes, 10dlc is configured, no candidates.
  assertCronAuthSpy.mockReturnValue(true);
  readConfigSpy.mockReturnValue({ apiKey: "k", brandId: "b", campaignId: "c" });
  listSpy.mockResolvedValue([]);
});

describe("POST /api/internal/tendlc-attach-retry", () => {
  it("returns 403 when cron auth fails", async () => {
    assertCronAuthSpy.mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it("short-circuits with skipped='10dlc_not_configured' when cold-start (config null)", async () => {
    readConfigSpy.mockReturnValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skipped).toBe("10dlc_not_configured");
    expect(body.data.processed).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("short-circuits with skipped='partial_config' when readTendlcConfig throws MissingTendlcConfigError", async () => {
    readConfigSpy.mockImplementation(() => {
      throw new MockedMissingTendlcConfigError(["campaignId"]);
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skipped).toBe("partial_config");
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("rethrows non-MissingTendlcConfigError thrown by readTendlcConfig (don't swallow real bugs)", async () => {
    readConfigSpy.mockImplementation(() => {
      throw new Error("unrelated");
    });
    await expect(POST(makeRequest())).rejects.toThrow(/unrelated/);
  });

  it("returns 500 when the list query throws", async () => {
    listSpy.mockRejectedValue(new Error("db down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it("counts each outcome kind separately", async () => {
    listSpy.mockResolvedValue([
      { business_id: "b1", to_e164: "+1", status: "pending", last_attempt_at: null },
      { business_id: "b2", to_e164: "+2", status: "pending", last_attempt_at: null },
      { business_id: "b3", to_e164: "+3", status: "pending", last_attempt_at: null },
      { business_id: "b4", to_e164: "+4", status: "rejected", last_attempt_at: null },
      { business_id: "b5", to_e164: "+5", status: "pending", last_attempt_at: null }
    ]);
    attachSpy
      .mockResolvedValueOnce({ kind: "registered", campaignId: "c" })
      .mockResolvedValueOnce({ kind: "pending", reason: "vetting" })
      .mockResolvedValueOnce({ kind: "rejected", reason: "rate" })
      // Transient infra error — must NOT be counted as rejected.
      .mockResolvedValueOnce({ kind: "error", reason: "telnyx 503" })
      // Per-row throw — must be caught and recorded as an error.
      .mockRejectedValueOnce(new Error("attach throw"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.processed).toBe(5);
    expect(body.data.registered).toBe(1);
    expect(body.data.pending).toBe(1);
    expect(body.data.rejected).toBe(1);
    expect(body.data.errors).toHaveLength(2); // transient + per-row throw
    const messages = body.data.errors.map((e: { message: string }) => e.message);
    expect(messages).toContain("telnyx 503");
    expect(messages).toContain("attach throw");
  });

  it("captures non-Error throws as their string representation", async () => {
    listSpy.mockResolvedValue([
      { business_id: "b1", to_e164: "+1", status: "pending", last_attempt_at: null }
    ]);
    attachSpy.mockRejectedValueOnce("string-failure");
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errors[0].message).toBe("string-failure");
  });

  it("includes a durationMs in the success response (always > 0 to two decimal places)", async () => {
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(typeof body.data.durationMs).toBe("number");
    expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
  });
});
