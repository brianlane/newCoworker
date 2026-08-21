import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateDataResidencyMode: vi.fn()
}));

import { POST } from "@/app/api/admin/data-residency/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateDataResidencyMode } from "@/lib/db/businesses";
import { ResidencyValidationError } from "@/lib/residency/tier-gate";
import { ResidencyReplayCronError } from "@/lib/residency/keep-window";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/data-residency", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/data-residency route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ_ID,
      tier: "enterprise"
    } as never);
    vi.mocked(updateDataResidencyMode).mockResolvedValue(undefined);
  });

  it("flips the mode for an enterprise business", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "dual" }));
    expect(res.status).toBe(200);
    expect(updateDataResidencyMode).toHaveBeenCalledWith(BIZ_ID, "dual");
  });

  it("surfaces the tier-gate rejection as a validation error", async () => {
    vi.mocked(updateDataResidencyMode).mockRejectedValue(
      new ResidencyValidationError("Data residency is an Enterprise plan feature.")
    );
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "vps" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("Enterprise plan feature");
  });

  it("surfaces the replay-cron rejection with its runbook fix, not a bare 500", async () => {
    // The case for failing closed on the cron check is that the block is
    // recoverable in a minute. That only holds if the admin can SEE which
    // step to run, so a generic 500 here would defeat the whole gate.
    vi.mocked(updateDataResidencyMode).mockRejectedValue(
      new ResidencyReplayCronError(
        "cannot flip data residency to 'dual': the edge-residency-replay cron is not active. " +
          "Run step 0 of the residency runbook."
      )
    );
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "dual" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("edge-residency-replay");
    expect(json.error.message).toContain("step 0");
  });

  it("rejects unknown modes", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "purged" }));
    expect(res.status).toBe(400);
    expect(updateDataResidencyMode).not.toHaveBeenCalled();
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest({ businessId: BIZ_ID, mode: "dual" }));
    expect(res.status).toBe(404);
    expect(updateDataResidencyMode).not.toHaveBeenCalled();
  });
});
